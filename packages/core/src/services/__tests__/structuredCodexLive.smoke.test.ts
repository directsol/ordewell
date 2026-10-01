import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { isStructuredSession, type ITerminalSession, type StructuredEvent, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';

/**
 * The opt-in live check for the Codex task connector on the structured
 * transport (ADR-0018, #54), gated like `structuredLive.smoke.test.ts` and for
 * the same reasons: real quota, real latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=codex npx vitest run --root packages/core structuredCodexLive
 *
 * Every case runs in a throwaway directory with dummy work. A Codex sandbox
 * that cannot start here fails the write cases with the connector's own
 * message in the assertion, never a pass.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('codex');
// gpt-5.4-mini is not in this account's catalog; luna is the cheapest listed.
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'gpt-5.6-luna';
const TIMEOUT_MS = 180_000;
const MARKER_PROMPT = 'Then print one final line containing only the completion marker. Build it by writing `<<<ORDEWELL_` immediately followed by `DONE_live-codex>>>` with nothing between the two parts.';
const marker = '<<<ORDEWELL_DONE_live-codex>>>';

function turnEnds(session: ITerminalSession) {
  if (!isStructuredSession(session)) throw new Error('not a structured session');
  const ends: StructuredTurnEnd[] = [];
  const events: StructuredEvent[] = [];
  let waiter: (() => void) | null = null;
  session.onTurnEnd((reason) => { ends.push(reason); waiter?.(); waiter = null; });
  session.onEvent((e) => events.push(e));
  return {
    session,
    ends,
    events,
    next: () => new Promise<void>((resolve) => { waiter = resolve; }),
  };
}

function spawnTask(runner: StructuredRunner, dir: string, taskId: string, prompt: string, mode: string, resumeSessionId?: string) {
  return runner.spawn({
    taskId,
    runner: 'codex',
    prompt,
    modelId: model,
    thinkingEffort: 'low',
    mode,
    cwd: dir,
    registry: new RunnerRegistry(),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
}

describe.runIf(live)('structured transport, Codex — live smoke', () => {
  const dirs: string[] = [];
  const dirFor = () => { const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-codex-')); dirs.push(dir); return dir; };
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('full auto: writes a file, reports its marker whole, one shell line, one completed turn', async () => {
    const dir = dirFor();
    const runner = new StructuredRunner();
    try {
      const session = await spawnTask(runner, dir, 'live-codex-full', `Run a shell command that writes the text hi into hello.txt. ${MARKER_PROMPT}`, 'fullAccess');
      const turns = turnEnds(session);
      const chunks: string[] = [];
      session.onOutput((text) => chunks.push(text));

      await turns.next();
      expect(turns.ends).toEqual(['completed']);
      expect(existsSync(join(dir, 'hello.txt')), session.getOutput()).toBe(true);
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hi');
      expect(chunks.some((chunk) => chunk.includes(marker)), session.getOutput()).toBe(true);
      expect(session.getOutput().match(/^› shell\(/gm) ?? []).toHaveLength(1);
    } finally { runner.stopAll(); }
  }, TIMEOUT_MS);

  it('Auto: a write inside the workspace needs no permission request', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-auto', `Run a shell command that writes the text hi into hello.txt. ${MARKER_PROMPT}`, 'agent');
      const turns = turnEnds(session);
      await turns.next();
      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(turns.events.filter((e) => e.type === 'permission_request')).toEqual([]);
      expect(existsSync(join(dir, 'hello.txt')), session.getOutput()).toBe(true);
      expect(session.getOutput()).toContain(marker);
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  it('queues a message sent mid-turn and delivers it when the turn ends', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-queue', 'Run the shell command `sleep 5`, then reply with only the word done.', 'fullAccess');
      const turns = turnEnds(session);
      await new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));

      turns.session.sendMessage('reply with the word PONG');
      expect(turns.events).toContainEqual(expect.objectContaining({ type: 'message_queued', text: 'reply with the word PONG' }));
      expect(turns.session.queued()).toHaveLength(1);

      await turns.next();
      if (turns.ends.length < 2) await turns.next();
      expect(turns.ends).toEqual(['completed', 'completed']);
      expect(turns.session.queued()).toEqual([]);
      expect(session.getOutput()).toContain('PONG');
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the session alive for the next message', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-interrupt', 'Run the shell command `sleep 60`, then summarize the result.', 'fullAccess');
      const turns = turnEnds(session);
      await new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));

      await turns.session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(turns.session.turnState()).toBe('idle');

      turns.session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  it('continues a finished session by its native id', async () => {
    const dir = dirFor();
    const first = new StructuredRunner();
    const second = new StructuredRunner();
    try {
      const session = await spawnTask(first, dir, 'live-codex-continue-1', 'Run a shell command that writes the text hi into hello.txt, then reply with only the word done.', 'fullAccess');
      const turns = turnEnds(session);
      await turns.next();
      const nativeId = turns.session.nativeSessionId();
      expect(nativeId).toBeTruthy();
      session.kill();

      const resumed = await spawnTask(second, dir, 'live-codex-continue-2', 'Which file did you write earlier? Answer with its name.', 'fullAccess', nativeId!);
      const again = turnEnds(resumed);
      await again.next();
      expect(again.ends, resumed.getOutput()).toEqual(['completed']);
      expect(resumed.getOutput()).toContain('hello.txt');
    } finally { first.stopAll(); second.stopAll(); }
  }, TIMEOUT_MS * 2);
});
