import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { isStructuredSession, type ITerminalSession, type StructuredEvent, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';

/**
 * The opt-in live check for the OpenCode connector on the structured
 * transport (ADR-0018), gated like `structuredLive.smoke.test.ts` and for the
 * same reasons: real quota, real latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=opencode npx vitest run --root packages/core structuredOpenCodeLive
 *
 * Every task runs in a throwaway directory under `build`, on a cheap model
 * unless ORDEWELL_LIVE_MODEL says otherwise, at its lowest variant.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('opencode');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'opencode-go/deepseek-v4.1-flash';
const TIMEOUT_MS = 180_000;

/** Built in two halves so a model that echoes its prompt cannot print the marker by accident. */
const markerOf = (name: string) => `<<<ORDEWELL_DONE_${name}>>>`;
const markerInstruction = (name: string) =>
  `Then print one final line containing only the completion marker. Build it by writing \`<<<ORDEWELL_\` immediately followed by \`DONE_${name}>>>\` with nothing between the two parts.`;

function turnEnds(session: ITerminalSession) {
  if (!isStructuredSession(session)) throw new Error('not a structured session');
  const ends: StructuredTurnEnd[] = [];
  let waiter: (() => void) | null = null;
  session.onTurnEnd((reason) => { ends.push(reason); waiter?.(); waiter = null; });
  return {
    session,
    ends,
    next: () => new Promise<void>((resolve) => { waiter = resolve; }),
  };
}

function harness() {
  let baseUrl: string | null = null;
  const fetchSeen: typeof fetch = (input, init) => {
    baseUrl ??= new URL(input instanceof Request ? input.url : String(input)).origin;
    return globalThis.fetch(input, init);
  };
  const runner = new StructuredRunner({ process: { fetch: fetchSeen } });
  const spawn = async (taskId: string, dir: string, prompt: string, resumeSessionId?: string) => {
    const session = await runner.spawn({
      taskId,
      runner: 'opencode',
      prompt,
      modelId: model,
      thinkingEffort: 'low',
      mode: 'build',
      cwd: dir,
      registry: new RunnerRegistry(),
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    const turns = turnEnds(session);
    const events: StructuredEvent[] = [];
    const chunks: string[] = [];
    turns.session.onEvent((e) => events.push(e));
    session.onOutput((text) => chunks.push(text));
    return { session: turns.session, turns, events, chunks };
  };
  return { runner, spawn, baseUrl: () => baseUrl };
}

describe.runIf(live)('structured transport — OpenCode live smoke', () => {
  it('runs a build-mode task turn: writes a file, reports its marker whole, answers permissions itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events, chunks } = await spawn('oc-build', dir,
        `Create a file named hello.txt in the current directory containing exactly: hi. ${markerInstruction('oc-build')}`);
      await turns.next();

      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(existsSync(join(dir, 'hello.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hi');
      expect(chunks.some((chunk) => chunk.includes(markerOf('oc-build'))), session.getOutput()).toBe(true);
      expect(session.getOutput()).toMatch(/^› \S+/m);

      const asked = events.filter((e) => e.type === 'permission_request');
      const decided = new Set(events.flatMap((e) => (e.type === 'permission_decided' ? [e.id] : [])));
      for (const request of asked) expect(decided.has(request.id)).toBe(true);
      expect(events.filter((e) => e.type === 'permission_withdrawn')).toEqual([]);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('protects the task server with a password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn, baseUrl } = harness();
    try {
      const { turns } = await spawn('oc-auth', dir, 'Reply with only the word: ok');
      const url = baseUrl();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const response = await globalThis.fetch(`${url}/session`);
      expect(response.status).toBe(401);
      await turns.next();
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('queues a message sent mid-turn and delivers it when the turn ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events } = await spawn('oc-queue', dir, 'Use the bash tool to run `sleep 5`, then reply with only the word: done');
      await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_call'), JSON.stringify(events) + session.getOutput()).toBe(true), { timeout: 60_000, interval: 250 });

      const id = session.sendMessage('reply with the word PONG');
      expect(events).toContainEqual({ type: 'message_queued', messageId: id, text: 'reply with the word PONG' });
      expect(session.queued().map((m) => m.id)).toEqual([id]);

      await vi.waitFor(() => expect(turns.ends).toEqual(['completed', 'completed']), { timeout: 120_000, interval: 250 });
      expect(events.some((e) => e.type === 'turn_start' && e.messageId === id)).toBe(true);
      expect(session.queued()).toEqual([]);
      expect(session.getOutput()).toContain('PONG');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the task alive for the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events } = await spawn('oc-interrupt', dir, 'Use the bash tool to run `sleep 60 && echo finished`, then summarize the result.');
      await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_call')).toBe(true), { timeout: 60_000, interval: 250 });

      await session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(session.turnState()).toBe('idle');

      session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('settles a ~20s turn from the idle status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const started = Date.now();
      const { session, turns, chunks } = await spawn('oc-long', dir,
        `Use the bash tool to run \`sleep 20\`. ${markerInstruction('oc-long')}`);
      await turns.next();

      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(chunks.some((chunk) => chunk.includes(markerOf('oc-long')))).toBe(true);
      expect(Date.now() - started).toBeLessThan(120_000);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('continues a finished task from its native session id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const first = await spawn('oc-continue-1', dir, 'Create a file named hello.txt in the current directory containing exactly: hi. Then reply with only the word: done');
      await first.turns.next();
      const saved = first.session.nativeSessionId();
      expect(saved).toBeTruthy();
      first.session.kill();

      const second = await spawn('oc-continue-2', dir, 'Which file did you write earlier? Answer with its name.', saved!);
      await second.turns.next();
      expect(second.turns.ends, second.session.getOutput()).toEqual(['completed']);
      expect(second.session.getOutput()).toContain('hello.txt');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
