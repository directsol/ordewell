import type { ChildProcess } from 'child_process';
import { augmentedPath, withPath } from '../../utils/shellPath';
import { planDirectLaunch, isExecutableResolved, ExecutableNotFoundError } from '../../utils/launch';
import { assertWorkspaceExists } from '../../utils/workspace';
import { killTree } from '../../utils/processTree';
import { workspaceEnvOf } from '../workspaceEnv';
import type { UsageRecord } from '../../models/Usage';
import type { AgentAdapter, AgentEvent, AgentProcessDeps, AgentStartOptions } from './AgentAdapter';

const SERVER_READY_TIMEOUT_MS = 30000;
const STDERR_TAIL_CHARS = 4000;
/** How long a turn waits for `/event` before posting anyway. See {@link OpenCodeAdapter.send}. */
const STREAM_CONNECT_TIMEOUT_MS = 5000;
/** See {@link OpenCodeAdapter.recoverReply}. */
const RECOVERY_POLL_INTERVAL_MS = 2000;
const RECOVERY_TIMEOUT_MS = 900000;

/**
 * Tools withheld from a planning session (T1). `question` is the load-bearing
 * one: it blocks the turn on an answer from a user who is not watching, and the
 * message POST then never returns — an absent answer has to mean denial, not a
 * hung planner. The rest are the write tools, withheld for the same reason
 * {@link ClaudeCodeAdapter} names them despite `--permission-mode plan`: the
 * `plan` agent already refuses them, and a future default must not quietly
 * hand the planner an edit.
 */
const DISABLED_TOOLS: Record<string, boolean> = {
  question: false,
  edit: false,
  write: false,
  apply_patch: false,
  todowrite: false,
};

interface OpenCodePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  messageID?: string;
  /** Set on a text or reasoning part once it is complete. */
  time?: { start?: number; end?: number };
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    /** On a `task` call once its child session exists: that session's id and the model it runs. */
    metadata?: { sessionId?: string; model?: { providerID?: string; modelID?: string } };
  };
}

/** `permission.asked` (and its v2 spelling) — the only server→client request OpenCode makes. */
interface OpenCodePermissionAsk {
  id?: string;
  sessionID?: string;
  permission?: string;
  action?: string;
  patterns?: string[];
  resources?: string[];
  metadata?: Record<string, unknown>;
}

interface OpenCodeMessageInfo {
  id?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  /** `AssistantMessage.error` is a tagged union: `{ name, data: { message } }`. */
  error?: { name?: string; data?: { message?: string } };
  providerID?: string;
  modelID?: string;
  /** USD, as OpenCode prices the call. */
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

/** One `/event` frame, narrowed to the fields this adapter reads. */
interface OpenCodeEvent {
  type?: string;
  properties?: OpenCodePermissionAsk & {
    part?: OpenCodePart;
    info?: OpenCodeMessageInfo & { parentID?: string };
    /** `message.part.delta`: an append to one field of a part already announced. */
    messageID?: string;
    partID?: string;
    field?: string;
    delta?: string;
  };
}

/**
 * What one turn has learned from `/event` so far. The stream names a part's
 * message but never its role, and a delta names neither its part's type nor
 * whether it belongs to the reply — so each is remembered from the frame that
 * announced it.
 */
interface TurnState {
  seen: Set<string>;
  /** Assistant message ids, from `message.updated`. A part of any other message is the user's own words. */
  assistantMessages: Set<string>;
  partTypes: Map<string, string>;
  /** Reply text parts that have started streaming — see {@link OpenCodeAdapter.onTextDelta}. */
  textRuns: Map<string, { held: string; lead: string | null }>;
  /** Child sessions of the planner's, mapped to the `task` call that spawned each once its part names it. */
  children: Map<string, string | null>;
  /** Frames from a child session that arrived before its `task` call named it. */
  heldFrames: Map<string, OpenCodeEvent[]>;
  /** `task` calls whose subagent has started, so a finish is reported only for one that began. */
  subagents: Set<string>;
}

interface OpenCodeMessageResponse {
  parts?: OpenCodePart[];
  info?: OpenCodeMessageInfo;
  error?: { message?: string } | string;
}

/**
 * OpenCode addresses a model as `{providerID, modelID}`; discovery and the
 * plan artifact carry the flat `provider/model` id the CLI's `--model` flag
 * takes. Split on the first slash — provider ids never contain one, model ids
 * sometimes do (`openrouter/anthropic/claude-sonnet-4`).
 */
function splitModelId(id: string): { providerID: string; modelID: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/**
 * Flatten an error and its `cause` chain into one line. Node's `fetch` reports
 * every transport failure as the same bare `TypeError: fetch failed`; which
 * failure it was (a socket reset, a refused connect, undici's 300s header
 * timeout) lives only in `cause`, so a message without it names nothing.
 */
function describeError(err: unknown): string {
  const visited = new Set<unknown>();
  const lines: string[] = [];
  let current: unknown = err;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (!(current instanceof Error)) { lines.push(String(current)); break; }
    const code = (current as { code?: unknown }).code;
    const suffix = typeof code === 'string' && !current.message.includes(code) ? ` (${code})` : '';
    lines.push(`${current.message}${suffix}`);
    current = current.cause;
  }
  return lines.join(': ');
}

function flatModelId(providerID: string | undefined, modelID: string | undefined): string | undefined {
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

/**
 * OpenCode's `input` counts only the uncached prompt — cache reads and writes
 * sit beside it, as with Anthropic: in the recordings `tokens.total` is input +
 * output + both cache counts. Its `output` excludes `reasoning` (a recorded
 * reply with text reports output 0 beside reasoning 127), and reasoning is
 * billed as output, so it is counted as output.
 */
function usageRecord(info: OpenCodeMessageInfo, subagentId?: string): UsageRecord | null {
  const tokens = info.tokens;
  if (!tokens) return null;
  const cached = tokens.cache?.read ?? 0;
  const inputTokens = (tokens.input ?? 0) + cached + (tokens.cache?.write ?? 0);
  const outputTokens = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  // A call that failed before the provider answered reports all zeros. That
  // is no measurement, and a zero prompt would read as an empty context.
  if (inputTokens + outputTokens === 0) return null;
  const record: UsageRecord = { source: 'opencode', inputTokens, outputTokens, cachedInputTokens: cached };
  const model = flatModelId(info.providerID, info.modelID);
  if (model) record.model = model;
  // OpenCode prices a call itself, from its model catalog, so a reported 0
  // means a free model or one the catalog has no price for. Those cannot be
  // told apart, so 0 is left unreported: a ledger may not claim a bill of
  // nothing.
  if (typeof info.cost === 'number' && info.cost > 0) record.reportedCost = { amount: info.cost, currency: 'USD' };
  if (subagentId) record.subagentId = subagentId;
  return record;
}

/** The subagent's report without the `<task>` envelope the tool wraps it in. */
function taskDigest(output: string): string {
  const inner = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/);
  return inner ? inner[1] : output;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * OpenCode as a planner, over its headless HTTP server (ADR-0009).
 *
 * The odd one out: `opencode serve` is a real server rather than a stdio
 * protocol, so this adapter owns both halves of the boundary — it spawns the
 * process through the same injected `spawn` every other adapter uses, then
 * talks to it through the injected `fetch`. Both are part of the one seam the
 * tests drive.
 *
 * The turn ends when the message POST resolves, and its response is the
 * authoritative copy of the reply's last message. Everything else — reply text
 * as it streams, earlier model calls' text and reasoning, per-call usage, the
 * subagents a `task` call runs — arrives only on the server's `/event` channel.
 * An event name that changes between OpenCode versions therefore costs that
 * detail, never the final reply.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly agentId = 'opencode';

  private process: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private sessionId: string | null = null;
  private stderrTail = '';
  private exited = false;
  private disposed = false;
  private opts: AgentStartOptions | null = null;
  /** Whether this turn has already emitted reply text — see {@link emitPart}. */
  private turnHasText = false;
  /** The last assistant message already settled — the baseline {@link recoverReply} measures a new reply against. */
  private lastAssistantId: string | null = null;

  constructor(private deps: AgentProcessDeps) {}

  async start(opts: AgentStartOptions): Promise<void> {
    this.opts = opts;
    // Checked before anything else: a workspace deleted out from under a
    // stale `process.cwd()` otherwise surfaces as `spawn`'s ENOENT, which
    // reads as a missing `opencode` binary rather than a missing directory.
    assertWorkspaceExists(opts.cwd, { isDirectory: this.deps.isDirectory });
    const resolvePath = this.deps.resolvePath ?? augmentedPath;
    const PATH = await resolvePath();

    // On POSIX this is `opencode` unchanged; on Windows it resolves the real
    // executable, because CreateProcess performs no PATHEXT lookup.
    const launch = await planDirectLaunch('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      platform: this.deps.platform,
      resolvePath,
    });
    if (!isExecutableResolved('opencode', launch, PATH, { platform: this.deps.platform, exists: this.deps.exists })) {
      throw new ExecutableNotFoundError('opencode', PATH);
    }
    this.process = this.deps.spawn(launch.file, launch.args, {
      env: withPath(process.env, PATH, await (this.deps.workspaceEnv ?? workspaceEnvOf)(opts.cwd)),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      windowsVerbatimArguments: launch.verbatim,
    });

    const banner = new Promise<string | null>((resolve) => {
      let seen = '';
      const scan = (chunk: Buffer) => {
        seen += chunk.toString();
        const match = seen.match(/https?:\/\/[^\s]+/);
        if (match) resolve(match[0].replace(/[.,)]$/, ''));
      };
      this.process!.stdout?.on('data', scan);
      this.process!.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        scan(chunk);
      });
      this.process!.on('exit', () => { this.exited = true; resolve(null); });
      this.process!.on('error', (err) => {
        this.exited = true;
        this.stderrTail = (this.stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_CHARS);
        resolve(null);
      });
      const timer = setTimeout(() => resolve(null), SERVER_READY_TIMEOUT_MS);
      timer.unref?.();
    });

    this.baseUrl = await banner;
    if (!this.baseUrl) {
      throw new Error(`The OpenCode planner server did not start.${this.stderrTail.trim() ? `\n\n${this.stderrTail.trim()}` : ''}`);
    }

    // A resume id names a session on disk, not on this process — so it is
    // checked rather than trusted. A stale one degrades to a fresh session
    // (T4), where the caller reseeds from Ordewell's own transcript.
    if (opts.resumeSessionId) {
      const existing = await this.json<{ id?: string }>('GET', `/session/${opts.resumeSessionId}`).catch(() => null);
      if (existing?.id) {
        this.sessionId = existing.id;
        // A resumed session already holds assistant messages. Without a
        // baseline, a recovery poll would accept one of those as this turn's
        // reply, so the newest is claimed as already-seen before any turn runs.
        const history = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${existing.id}/message`).catch(() => null);
        this.lastAssistantId = this.newestAssistantId(history);
        return;
      }
    }
    const created = await this.json<{ id?: string }>('POST', '/session', {});
    if (!created?.id) throw new Error('The OpenCode planner server did not return a session id.');
    this.sessionId = created.id;
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.baseUrl || !this.sessionId) throw new Error('OpenCode planner session is not started');
    if (this.exited) {
      onEvent({ type: 'error', message: this.exitMessage() });
      return;
    }

    const turn: TurnState = {
      seen: new Set(),
      assistantMessages: new Set(),
      partTypes: new Map(),
      textRuns: new Map(),
      children: new Map(),
      heldFrames: new Map(),
      subagents: new Set(),
    };
    this.turnHasText = false;
    const streamAbort = new AbortController();
    let connected: () => void = () => {};
    const streamReady = new Promise<void>((resolve) => { connected = resolve; });
    const live = this.streamEvents(streamAbort.signal, (frame) => this.onFrame(frame, turn, onEvent), connected, onActivity);

    // The stream stopped being best-effort the moment permission denial moved
    // onto it: a request raised before we connect is one nobody answers, and
    // the message POST then hangs until its own timeout. Waiting is bounded so
    // a server that never opens `/event` still gets its turn.
    await Promise.race([streamReady, new Promise<void>((r) => { const t = setTimeout(r, STREAM_CONNECT_TIMEOUT_MS); t.unref?.(); })]);

    try {
      const model = this.opts?.model ? splitModelId(this.opts.model) : null;
      const body = {
        parts: [{ type: 'text', text: message }],
        // The read-only guarantee: OpenCode's own plan agent has no write tools.
        agent: 'plan',
        tools: DISABLED_TOOLS,
        ...(model ? { model } : {}),
        ...(this.opts?.effort ? { variant: this.opts.effort } : {}),
        ...(this.opts?.systemPrompt ? { system: this.opts.systemPrompt } : {}),
      };
      const reply = await this.json<OpenCodeMessageResponse>('POST', `/session/${this.sessionId}/message`, body, signal);

      if (signal?.aborted) { this.dispose(); return; }
      this.settle(reply, turn, onEvent);
    } catch (err) {
      if (signal?.aborted) { this.dispose(); return; }
      // The POST is the turn's transport, not its work: the server plans on
      // regardless of what happened to this socket. So a transport failure
      // reads the reply back out of the session rather than losing a turn the
      // server already finished (or is still finishing).
      const recovered = this.exited ? null : await this.recoverReply(signal, onActivity);
      if (recovered) { this.settle(recovered, turn, onEvent); return; }
      onEvent({ type: 'error', message: `The OpenCode planner turn failed: ${describeError(err)}` });
    } finally {
      streamAbort.abort();
      await live.catch(() => { /* the stream is best-effort */ });
    }
  }

  /**
   * Turn one settled assistant message into events. The settled response is
   * authoritative: it names the assistant message, so its parts are the ones
   * that make up the reply. Parts already completed live are deduplicated;
   * anything the stream missed (including a stream that never connected)
   * arrives here.
   *
   * It is only the turn's *last* message, though. OpenCode writes one
   * assistant message per model call, so the calls before the final one —
   * their text, reasoning and usage — reach Ordewell over the stream or not at
   * all.
   */
  private settle(reply: OpenCodeMessageResponse | null, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const failure = typeof reply?.error === 'string'
      ? reply.error
      : (reply?.error as { message?: string } | undefined)?.message ?? reply?.info?.error?.data?.message;
    if (failure) {
      onEvent({ type: 'error', message: failure });
      return;
    }
    const assistantId = reply?.info?.id;
    for (const part of reply?.parts ?? []) {
      if (part.type !== 'tool' && assistantId && part.messageID !== assistantId) continue;
      this.emitPart(part, turn, onEvent);
    }
    if (reply?.info) this.countUsage(reply.info, turn, onEvent);
    if (assistantId) this.lastAssistantId = assistantId;
    onEvent({ type: 'turn_end' });
  }

  /**
   * Poll the session for this turn's assistant message after the POST's socket
   * died under it. Node's global `fetch` is undici, which aborts a request
   * whose response headers have not arrived within 300s — and OpenCode sends
   * none until the turn is done, so any turn past five minutes fails as
   * `TypeError: fetch failed` while the server is still working. The message
   * exists server-side either way, so it is waited for and read back.
   *
   * A message that exists but has not completed is progress, not an answer:
   * it refreshes the watchdog and the poll continues.
   */
  private async recoverReply(signal: AbortSignal | undefined, onActivity?: () => void): Promise<OpenCodeMessageResponse | null> {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    for (;;) {
      if (signal?.aborted || this.exited || this.disposed || !this.sessionId) return null;
      const messages = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${this.sessionId}/message`).catch(() => null);
      const pending = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m.info?.role === 'assistant' && m.info.id && m.info.id !== this.lastAssistantId)
        : undefined;
      if (pending?.info?.time?.completed || pending?.info?.error) return pending;
      if (pending) onActivity?.();
      if (Date.now() >= deadline) return null;
      await delay(RECOVERY_POLL_INTERVAL_MS, signal);
    }
  }

  private newestAssistantId(messages: OpenCodeMessageResponse[] | null): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant' && info.id) return info.id;
    }
    return null;
  }

  /**
   * Emit one complete message part, once. OpenCode reports a tool part
   * repeatedly as it moves through pending → running → completed, so parts are
   * keyed by id and only the terminal state produces a result. A subagent's
   * text is its report to the planner, not the reply, so it is dropped; the
   * `task` call's result carries it.
   */
  private emitPart(part: OpenCodePart, turn: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    if (!part?.type) return;
    const { seen } = turn;
    const id = part.id ?? part.callID ?? '';

    if (part.type === 'text' && part.text && !subagentId) {
      if (seen.has(`text:${id}`)) return;
      seen.add(`text:${id}`);
      // Some models open a message with a text part of nothing but newlines
      // before calling a tool. It says nothing, and as a paragraph of its own
      // it would push the real reply down by a blank one.
      if (!part.text.trim()) return;
      // One message can carry text on both sides of a tool call. Concatenated
      // raw they run together, so each part after the first opens a paragraph.
      const lead = turn.textRuns.get(id)?.lead ?? (this.turnHasText ? '\n\n' : '');
      onEvent({ type: 'assistant_text', text: `${lead}${part.text}` });
      this.turnHasText = true;
      return;
    }
    if (part.type === 'reasoning' && part.text) {
      if (seen.has(`reasoning:${id}`)) return;
      seen.add(`reasoning:${id}`);
      onEvent({ type: 'thinking', text: part.text, subagentId });
      return;
    }
    if (part.type !== 'tool') return;

    const callId = part.callID ?? id;
    const name = part.tool ?? 'tool';
    const status = part.state?.status;
    const input = part.state?.input;
    // A `pending` tool part carries no input yet, so announcing it there gave
    // every call an empty arg summary. Waiting for the first state that has
    // input costs a moment of liveness and buys a readable timeline.
    if (!seen.has(`call:${callId}`) && (status !== 'pending' || (input && Object.keys(input).length > 0))) {
      seen.add(`call:${callId}`);
      onEvent({ type: 'tool_call', id: callId, name, args: input ?? {}, subagentId });
    }
    if (name === 'task' && !subagentId) this.trackSubagent(part, callId, turn, onEvent);
    if ((status === 'completed' || status === 'error') && !seen.has(`result:${callId}`)) {
      seen.add(`result:${callId}`);
      onEvent({
        type: 'tool_result',
        id: callId,
        name,
        output: part.state?.output ?? part.state?.error ?? '',
        success: status === 'completed',
        subagentId,
      });
    }
  }

  /**
   * A `task` call runs a subagent in a child session. The call's part names
   * that session once it exists, which is what ties the child's frames to the
   * call; the subagent ends when the call does.
   */
  private trackSubagent(part: OpenCodePart, callId: string, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const state = part.state;
    const child = state?.metadata?.sessionId;
    if (child && !turn.subagents.has(callId)) {
      turn.subagents.add(callId);
      const input = state?.input ?? {};
      const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
      const model = flatModelId(state?.metadata?.model?.providerID, state?.metadata?.model?.modelID);
      onEvent({ type: 'subagent_started', subagentId: callId, brief, ...(model ? { model } : {}) });
      turn.children.set(child, callId);
      const held = turn.heldFrames.get(child) ?? [];
      turn.heldFrames.delete(child);
      for (const frame of held) this.onFrame(frame, turn, onEvent);
    }
    const status = state?.status;
    if ((status === 'completed' || status === 'error') && turn.subagents.delete(callId)) {
      onEvent({
        type: 'subagent_finished',
        subagentId: callId,
        outcome: status === 'completed' ? 'done' : 'failed',
        digest: taskDigest(state?.output ?? state?.error ?? ''),
      });
    }
  }

  /**
   * One message's usage, once, when it has completed. Every assistant message
   * is one model call; until it completes its counts are zeros.
   */
  private countUsage(info: OpenCodeMessageInfo, turn: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    if (info.role !== 'assistant' || !info.id || !info.time?.completed || turn.seen.has(`usage:${info.id}`)) return;
    turn.seen.add(`usage:${info.id}`);
    const record = usageRecord(info, subagentId);
    if (record) onEvent({ type: 'usage', record });
  }

  /**
   * One `/event` frame. Only the planner's session and its children are
   * followed: the server's stream is global, and another client's session is
   * none of this turn's business.
   */
  private onFrame(frame: OpenCodeEvent, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const props = frame.properties;
    if (!props) return;
    if (frame.type === 'session.created') {
      if (props.info?.parentID === this.sessionId && props.info.id && !turn.children.has(props.info.id)) turn.children.set(props.info.id, null);
      return;
    }
    const session = props.sessionID;
    if (session && session !== this.sessionId && !turn.children.has(session)) return;
    // Answered before anything waits on the `task` call naming its session: a
    // subagent's request blocks the planner's turn exactly as the planner's own does.
    if (frame.type === 'permission.asked' || frame.type === 'permission.v2.asked') {
      this.denyPermission(props, turn.seen, onEvent);
      return;
    }
    let subagentId: string | undefined;
    if (session && session !== this.sessionId) {
      const owner = turn.children.get(session);
      if (!owner) {
        turn.heldFrames.set(session, [...(turn.heldFrames.get(session) ?? []), frame]);
        return;
      }
      subagentId = owner;
    }

    if (frame.type === 'message.updated' && props.info) {
      if (props.info.role === 'assistant' && props.info.id) turn.assistantMessages.add(props.info.id);
      this.countUsage(props.info, turn, onEvent, subagentId);
      return;
    }
    if (frame.type === 'message.part.delta') {
      if (props.field !== 'text' || !props.partID || !props.delta) return;
      if (!props.messageID || !turn.assistantMessages.has(props.messageID)) return;
      const type = turn.partTypes.get(props.partID);
      if (type === 'reasoning') onEvent({ type: 'thinking_delta', text: props.delta, subagentId });
      else if (type === 'text' && !subagentId) this.onTextDelta(props.partID, props.delta, turn, onEvent);
      return;
    }
    const part = props.part;
    if (!part) return;
    if (part.type === 'tool') {
      this.emitPart(part, turn, onEvent, subagentId);
      return;
    }
    // The server replays the user's own message back as text parts, with no
    // role on the frame. Letting it through would put the user's goal into the
    // planner's reply, and a goal containing JSON would be parsed as the plan
    // — so a part counts only once `message.updated` has named its message an
    // assistant's.
    if (!part.id || !part.messageID || !turn.assistantMessages.has(part.messageID)) return;
    if (part.type === 'text' || part.type === 'reasoning') turn.partTypes.set(part.id, part.type);
    if (part.time?.end) this.emitPart(part, turn, onEvent, subagentId);
  }

  /**
   * Stream one piece of a reply text part. The part's paragraph break goes out
   * with its first visible delta, so the deltas add up to exactly the text the
   * completed part then re-sends; a part that is only whitespace so far is
   * held back, for the reason {@link emitPart} drops one.
   */
  private onTextDelta(partId: string, delta: string, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    if (turn.seen.has(`text:${partId}`)) return;
    const run = turn.textRuns.get(partId) ?? { held: '', lead: null };
    turn.textRuns.set(partId, run);
    if (run.lead !== null) {
      onEvent({ type: 'assistant_text_delta', text: delta });
      return;
    }
    run.held += delta;
    if (!run.held.trim()) return;
    run.lead = this.turnHasText ? '\n\n' : '';
    this.turnHasText = true;
    onEvent({ type: 'assistant_text_delta', text: `${run.lead}${run.held}` });
  }

  /**
   * Deny one permission request (T1). OpenCode blocks the turn until the
   * request is answered, so this must answer — `reject` rather than a silent
   * drop, which is the same "absent answer is a denial" invariant ADR-0008
   * states for Ordewell's own tools. The refusal is announced so the timeline
   * shows the planner reaching for something it may not have.
   */
  private denyPermission(ask: OpenCodePermissionAsk, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    const id = ask.id;
    if (!id || seen.has(`perm:${id}`)) return;
    seen.add(`perm:${id}`);
    const name = ask.permission ?? ask.action ?? 'permission';
    const scope = (ask.patterns ?? ask.resources ?? []).join(', ');
    onEvent({
      type: 'permission_request',
      id,
      name,
      detail: JSON.stringify({ ...(scope ? { scope } : {}), ...(ask.metadata ?? {}) }),
    });
    void this.json('POST', `/session/${ask.sessionID ?? this.sessionId}/permissions/${id}`, { response: 'reject' })
      .catch(() => { /* a server that forgot the request will not hang on it either */ });
  }

  /**
   * Server-sent events from `/event`: the turn's live text, reasoning, tool
   * activity and usage, and the only channel permission requests arrive on —
   * so the stream is load-bearing for {@link denyPermission}.
   */
  private async streamEvents(
    signal: AbortSignal,
    onFrame: (frame: OpenCodeEvent) => void,
    onConnected: () => void,
    onActivity?: () => void,
  ): Promise<void> {
    const response = await this.deps.fetch(`${this.baseUrl}/event`, { signal }).catch(() => null);
    const body = response?.body;
    if (!body) { onConnected(); return; }
    onConnected();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      // Any bytes at all mean the server is still talking, independent of
      // whether this chunk resolves into a part this adapter forwards —
      // the same gap that made Claude Code's watchdog false-positive on
      // filtered subagent output, closed here before it can recur.
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          onFrame(JSON.parse(line.slice(5).trim()) as OpenCodeEvent);
        } catch {
          // A partial or unrecognized frame costs one event, not the turn.
        }
      }
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
    const response = await this.deps.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    return (await response.json().catch(() => null)) as T | null;
  }

  nativeSessionId(): string | null { return this.sessionId; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.process;
    this.process = null;
    this.baseUrl = null;
    // Tree-wide: `opencode serve` is a server, and on Windows it may sit behind
    // a cmd.exe shim. A surviving server keeps the port and the session.
    killTree(proc, { platform: this.deps.platform });
  }

  private exitMessage(): string {
    const tail = this.stderrTail.trim();
    return `The OpenCode planner server exited.${tail ? `\n\n${tail}` : ''}`;
  }
}
