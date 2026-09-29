import type { SubagentOutcome } from '../../models/Task';
import { partedPromptUsage, type UsageRecord } from '../../models/Usage';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';

/**
 * Tools a planning Claude Code session may use. `--permission-mode plan`
 * already refuses edits; naming the write tools explicitly means a future
 * permission-mode change cannot quietly hand the planner a `Write` (T1).
 */
const DISALLOWED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell'];

/**
 * The flags that make Claude Code speak its bidirectional protocol, the same
 * for a planner and a task. `--verbose` because stream-json output is rejected
 * without it.
 */
const PROTOCOL_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
];

/**
 * How Claude Code reports an `Agent` call it decided to run in the background.
 * The tool *input* carries no flag — backgrounding is the CLI's own choice,
 * announced only in the result — so this string is the sole signal. If a future
 * release rewords it the planner is no more lossy than it was before, which is
 * why nothing downstream treats its absence as "no agents are running".
 */
const ASYNC_LAUNCH_MARKER = 'Async agent launched successfully';

interface ClaudeBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One Anthropic Messages streaming event, as `--include-partial-messages` relays it. */
interface ClaudeStreamEvent {
  type: string;
  message?: { model?: string };
  usage?: ClaudeUsage;
  content_block?: { type: string };
  delta?: { type?: string; text?: string; thinking?: string };
}

interface ClaudeLine {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[]; tool_use_id?: string };
  /** `control_response`: the answer to a request Ordewell sent, such as an interrupt. */
  response?: { subtype?: string; request_id?: string; error?: string };
  message?: { id?: string; model?: string; usage?: ClaudeUsage; content?: ClaudeBlock[] | string };
  /** Non-null on every line produced inside a subagent the planner spawned. */
  parent_tool_use_id?: string | null;
  event?: ClaudeStreamEvent;
  /** The tool's structured result beside its text; for an `Agent` call it holds the subagent's last call's usage. */
  tool_use_result?: unknown;
  /** Cumulative over the whole agent session — including turns before a `--resume`. */
  total_cost_usd?: number;
  modelUsage?: Record<string, { contextWindow?: number }>;
  /** `task_notification`: which `Agent` call finished, how, and what it reported. */
  tool_use_id?: string;
  status?: string;
  summary?: string;
}

/** The tool Claude Code delegates to a subagent with — `Task` before it was renamed `Agent`. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** Anthropic's `input_tokens` is only the uncached tail of the prompt — see {@link partedPromptUsage}. */
function usageRecord(usage: ClaudeUsage, model: string | undefined, subagentId?: string): UsageRecord {
  const record: UsageRecord = {
    source: 'claude-code',
    ...partedPromptUsage({ uncached: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }),
  };
  if (model) record.model = model;
  if (usage.output_tokens !== undefined) record.outputTokens = usage.output_tokens;
  if (subagentId) record.subagentId = subagentId;
  return record;
}

/** The last call's usage an `Agent` result carries, and the model that made it. */
function subagentFinalCall(result: unknown): { usage: ClaudeUsage; model?: string } | null {
  if (typeof result !== 'object' || result === null) return null;
  const { usage, resolvedModel } = result as { usage?: unknown; resolvedModel?: unknown };
  if (typeof usage !== 'object' || usage === null) return null;
  return { usage: usage as ClaudeUsage, model: typeof resolvedModel === 'string' ? resolvedModel : undefined };
}

/** Anything but a clean finish is not reported as one. */
function notificationOutcome(status: string | undefined): SubagentOutcome {
  if (status === 'completed') return 'done';
  if (status === 'killed' || status === 'stopped') return 'stopped';
  return 'failed';
}

function blocksOf(msg: ClaudeLine): ClaudeBlock[] {
  return Array.isArray(msg.message?.content) ? msg.message.content : [];
}

/** Tool results arrive as a string, or as a content-block array. Flatten both. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : typeof (block as ClaudeBlock)?.text === 'string' ? (block as ClaudeBlock).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Claude Code as a planner, over its bidirectional streaming-JSON transport
 * (ADR-0009).
 *
 * `-p --input-format stream-json --output-format stream-json` keeps one process
 * alive across turns: user messages go in as JSON lines, and the session's
 * assistant blocks, tool uses, tool results and turn boundaries come back the
 * same way. It is the richest of the three streams — partial messages and
 * separate thinking blocks — which is why this agent went first.
 */
export class ClaudeCodeAdapter extends StdioAgentAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'claude-code';

  private interruptCount = 0;
  /** Interrupts sent and not yet acknowledged, by request id. */
  private readonly pendingControl = new Map<string, (ok: boolean) => void>();
  /** An interrupt was sent during the current turn, so an aborted result is that interrupt, not a failure. */
  private interruptRequested = false;

  /** Whether this turn has already emitted reply text — see {@link handleLine}. */
  private turnHasText = false;
  /** The text block streaming now follows earlier reply text, so its first delta opens the paragraph. */
  private pendingBreak = false;
  /** The model answering the planner's current message, as its `message_start` named it. */
  private plannerModel: string | undefined;
  /**
   * The session's `total_cost_usd` as last reported. Undefined after a resume:
   * the CLI restores the resumed session's running total, and what Ordewell
   * already counted of it is not ours to know here.
   */
  private reportedCostUsd: number | undefined = 0;
  /**
   * Subagents started and not yet finished, keyed by the `Agent` call's id.
   * Kept across turns: a backgrounded one reports after its turn has ended.
   */
  private readonly openSubagents = new Map<string, { background: boolean }>();
  /** Subagent messages already counted. A message arrives as one line per content block, each repeating its usage. */
  private readonly countedSubagentMessages = new Set<string>();

  protected spawnSpec(opts: AgentStartOptions): SpawnSpec {
    if (opts.kind === 'task') return this.taskSpawnSpec(opts);
    const args = [
      ...PROTOCOL_ARGS,
      // The read-only guarantee, enforced at spawn rather than by prompt.
      '--permission-mode', 'plan',
      '--disallowedTools', DISALLOWED_TOOLS.join(','),
      '--append-system-prompt', opts.systemPrompt,
    ];
    if (opts.model) args.push('--model', opts.model);
    // `adaptive` is a thinking *type*, not an effort rung: `--effort adaptive`
    // is warned about and ignored, and adaptive is the default for every model
    // that offers it. Passing nothing is the same run without the warning on
    // stderr.
    if (opts.effort && opts.effort !== 'adaptive') args.push('--effort', opts.effort);
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      this.reportedCostUsd = undefined;
    }
    return { command: 'claude', args };
  }

  /**
   * A task's run: the manifest decides what its mode and effort mean
   * (ADR-0001), and this adds only the protocol around them. No tool list and
   * no system prompt — the task's prompt is its first turn, as on the terminal
   * transport. `--permission-prompt-tool stdio` routes the questions the mode
   * leaves open to the control channel, where the adapter must answer them;
   * without it `-p` refuses them silently and nothing can ever surface one.
   */
  private taskSpawnSpec(opts: TaskStartOptions): SpawnSpec {
    const args = [
      ...PROTOCOL_ARGS,
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', opts.flags.permissionMode,
      ...opts.flags.effortArgs,
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      this.reportedCostUsd = undefined;
    }
    return { command: 'claude', args };
  }

  /**
   * Claude Code's soft interrupt: the turn stops, the process and its session
   * stay. The CLI acknowledges on the control channel, then closes the turn
   * with an `error_during_execution` result, which {@link handleLine} reports
   * as an interrupted `turn_end`.
   */
  interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.process) return Promise.resolve(false);
    this.interruptCount += 1;
    const requestId = `ordewell-interrupt-${this.interruptCount}`;
    this.interruptRequested = true;
    return new Promise<boolean>((resolve) => {
      const settle = (ok: boolean) => {
        if (!this.pendingControl.delete(requestId)) return;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      timer.unref?.();
      this.pendingControl.set(requestId, settle);
      void this.processEnded.then(() => settle(false));
      this.writeLine({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    });
  }

  protected turnPayload(message: string): string {
    this.turnHasText = false;
    this.interruptRequested = false;
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    })}\n`;
  }

  protected handleLine(line: string, emit: (event: AgentEvent) => void): void {
    const msg = StdioAgentAdapter.parse<ClaudeLine>(line);
    if (!msg) return;

    if (msg.session_id) this.sessionId = msg.session_id;

    // Subagent traffic, replayed on the same stream with the spawning tool call
    // named. It is not the planner talking: forwarded as the planner's own, a
    // subagent's running commentary lands in the reply, and the user reads an
    // answer addressed to a prompt they never sent. So its steps are tagged
    // with the subagent and its text is never reply text.
    const subagentId = msg.parent_tool_use_id ?? undefined;

    switch (msg.type) {
      // The control channel: Claude asks whether a tool may run when its mode
      // cannot decide alone. A read-only planner answers "deny", every time —
      // and must answer, because an unacknowledged request stalls the turn.
      // A task denies too until approvals reach a person (#56), but the whole
      // request is passed on so that answer can be someone's to give.
      case 'control_request': {
        if (msg.request?.subtype !== 'can_use_tool') return;
        this.writeLine({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: msg.request_id,
            response: {
              behavior: 'deny',
              message: this.role === 'task'
                ? 'Ordewell cannot ask anyone to approve this yet, so it is denied. Continue without it, or say what you need.'
                : 'The Ordewell planner is read-only. Mutation belongs to the runners that execute the plan.',
            },
          },
        });
        const input = msg.request?.input ?? {};
        emit({
          type: 'permission_request',
          id: msg.request_id ?? '',
          name: msg.request?.tool_name ?? 'unknown',
          detail: JSON.stringify(input),
          ...(this.role === 'task' ? {
            input,
            suggestions: msg.request?.permission_suggestions ?? [],
            ...(msg.request?.tool_use_id ? { toolUseId: msg.request.tool_use_id } : {}),
          } : {}),
        });
        return;
      }

      case 'control_response': {
        const requestId = msg.response?.request_id;
        if (requestId) this.pendingControl.get(requestId)?.(msg.response?.subtype === 'success');
        return;
      }

      case 'assistant':
        if (subagentId) {
          this.handleSubagentMessage(msg, subagentId, emit);
          return;
        }
        for (const block of blocksOf(msg)) {
          // A turn is several whole messages — narration between tool rounds,
          // then the final answer — not a token stream. Concatenated raw they
          // run together ("…in parallel.That agent returned…"), so each one
          // after the first opens a paragraph.
          if (block.type === 'text' && block.text) {
            emit({ type: 'assistant_text', text: this.turnHasText ? `\n\n${block.text}` : block.text });
            this.turnHasText = true;
          } else if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking });
          else if (block.type === 'tool_use' && block.name) {
            const id = block.id ?? block.name;
            emit({ type: 'tool_call', id, name: block.name, args: block.input ?? {} });
            if (SUBAGENT_TOOLS.has(block.name) && block.id) this.startSubagent(block.id, block.input ?? {}, emit);
          }
        }
        return;

      case 'user':
        // The transport echoes tool results back as a synthetic user message.
        for (const block of blocksOf(msg)) {
          if (block.type !== 'tool_result') continue;
          const id = block.tool_use_id ?? '';
          const output = flattenContent(block.content);
          const subagent = subagentId ? undefined : this.openSubagents.get(id);
          if (!subagentId && output.includes(ASYNC_LAUNCH_MARKER)) {
            emit({ type: 'background_agent', id });
            if (subagent) subagent.background = true;
          } else if (subagent) {
            this.finishForegroundSubagent(id, msg.tool_use_result, output, block.is_error === true, emit);
          }
          emit({ type: 'tool_result', id, name: '', output, success: block.is_error !== true, subagentId });
        }
        return;

      case 'system':
        // A backgrounded subagent's only completion signal: its `Agent` call
        // returned at launch, long before the work ended.
        if (msg.subtype === 'task_notification' && msg.tool_use_id && this.openSubagents.get(msg.tool_use_id)?.background) {
          this.openSubagents.delete(msg.tool_use_id);
          emit({ type: 'subagent_finished', subagentId: msg.tool_use_id, outcome: notificationOutcome(msg.status), digest: msg.summary ?? '' });
        }
        return;

      case 'result':
        // `result` closes every turn — success or failure. The final assistant
        // text (which carries the plan JSON) already arrived as assistant
        // blocks, so this only settles the turn.
        this.reportSessionCost(msg, emit);
        if (this.interruptRequested && (msg.is_error || msg.subtype !== 'success')) {
          this.interruptRequested = false;
          emit({ type: 'turn_end', interrupted: true });
        } else if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          emit({ type: 'error', message: msg.result?.trim() || `Claude Code ended the turn: ${msg.subtype ?? 'error'}` });
        } else {
          emit({ type: 'turn_end' });
        }
        return;

      case 'stream_event':
        // Only the planner's own messages stream; a subagent's arrive whole.
        if (msg.event && !subagentId) this.handleStreamEvent(msg.event, emit);
        return;

      default:
        return;
    }
  }

  private startSubagent(id: string, input: Record<string, unknown>, emit: (event: AgentEvent) => void): void {
    this.openSubagents.set(id, { background: false });
    const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
    emit({ type: 'subagent_started', subagentId: id, brief, model: typeof input.model === 'string' ? input.model : undefined });
  }

  /**
   * A subagent's messages do not stream, so each line's usage is the snapshot
   * taken before generation: the prompt is real, the output a placeholder.
   * Only the prompt side is reported — an absent output count reads as "not
   * reported", a placeholder would read as a measurement.
   */
  private handleSubagentMessage(msg: ClaudeLine, subagentId: string, emit: (event: AgentEvent) => void): void {
    const messageId = msg.message?.id;
    if (msg.message?.usage && messageId && !this.countedSubagentMessages.has(messageId)) {
      this.countedSubagentMessages.add(messageId);
      emit({ type: 'usage', record: usageRecord({ ...msg.message.usage, output_tokens: undefined }, msg.message.model, subagentId) });
    }
    for (const block of blocksOf(msg)) {
      if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking, subagentId });
      else if (block.type === 'tool_use' && block.name) {
        emit({ type: 'tool_call', id: block.id ?? block.name, name: block.name, args: block.input ?? {}, subagentId });
      }
    }
  }

  /**
   * The `Agent` call returned, so the subagent is done. Its last call — the
   * report — never appears as a line of its own; the result carries its
   * complete usage instead.
   */
  private finishForegroundSubagent(id: string, result: unknown, output: string, failed: boolean, emit: (event: AgentEvent) => void): void {
    this.openSubagents.delete(id);
    const finalCall = subagentFinalCall(result);
    if (finalCall) emit({ type: 'usage', record: usageRecord(finalCall.usage, finalCall.model, id) });
    emit({ type: 'subagent_finished', subagentId: id, outcome: failed ? 'failed' : 'done', digest: output });
  }

  /**
   * Partial output of the planner's own message. The complete `assistant` line
   * for each block follows its deltas and is authoritative for that block (see
   * {@link AgentEvent}), so nothing here has to reconcile with it.
   */
  private handleStreamEvent(event: ClaudeStreamEvent, emit: (event: AgentEvent) => void): void {
    // Token counts come from `message_delta` alone. The `assistant` lines carry
    // a usage snapshot taken at `message_start`, before any output — its
    // `output_tokens` is a placeholder — and the result's `usage` re-sums these
    // same calls, so either would count them twice.
    if (event.type === 'message_start') this.plannerModel = event.message?.model;
    else if (event.type === 'message_delta' && event.usage) emit({ type: 'usage', record: usageRecord(event.usage, this.plannerModel) });
    else if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      this.pendingBreak = this.turnHasText;
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      if (this.pendingBreak) emit({ type: 'assistant_text_delta', text: '\n\n' });
      this.pendingBreak = false;
      emit({ type: 'assistant_text_delta', text: event.delta.text });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      emit({ type: 'thinking_delta', text: event.delta.thinking });
    }
  }

  /**
   * What only the result line knows: the cost, which covers every call the
   * session made — subagents included, since none of their lines carries one —
   * and the planner model's window. `total_cost_usd` is a running total, so a
   * turn reports its growth. The first turn after a resume only sets the
   * baseline: its total includes turns counted before, and a turn's own share
   * cannot be told apart from them.
   */
  private reportSessionCost(msg: ClaudeLine, emit: (event: AgentEvent) => void): void {
    const record: UsageRecord = { source: 'claude-code' };
    const total = msg.total_cost_usd;
    if (typeof total === 'number') {
      if (this.reportedCostUsd !== undefined && total > this.reportedCostUsd) {
        record.reportedCost = { amount: total - this.reportedCostUsd, currency: 'USD' };
      }
      this.reportedCostUsd = total;
    }
    const contextWindow = this.plannerModel ? msg.modelUsage?.[this.plannerModel]?.contextWindow : undefined;
    if (contextWindow !== undefined) record.contextWindow = contextWindow;
    if (record.reportedCost || record.contextWindow !== undefined) emit({ type: 'usage', record });
  }
}
