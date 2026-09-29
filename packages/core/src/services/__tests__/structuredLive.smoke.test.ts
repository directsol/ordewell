import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { isStructuredSession, type ITerminalSession, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';

/**
 * The opt-in live check for the structured transport (ADR-0018), gated like
 * `harnessLive.smoke.test.ts` and for the same reasons: real quota, real
 * latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core structuredLive
 *
 * It runs in a throwaway directory under `acceptEdits`, on the cheapest model
 * unless ORDEWELL_LIVE_MODEL says otherwise. What it asserts is the transport:
 * the marker reaches `onOutput` whole, a tool call becomes one line, and a
 * soft interrupt ends the turn without ending the task.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'haiku';
const TIMEOUT_MS = 180_000;

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

describe.runIf(live)('structured transport — live smoke', () => {
  it('runs a Claude Code task turn and reports its marker whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    const runner = new StructuredRunner();
    const marker = '<<<ORDEWELL_DONE_live-smoke>>>';
    try {
      const session = await runner.spawn({
        taskId: 'live-smoke',
        runner: 'claude-code',
        prompt: 'Run `cat README.md` with the Bash tool. Then print one final line containing only the completion marker. Build it by writing `<<<ORDEWELL_` immediately followed by `DONE_live-smoke>>>` with nothing between the two parts.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const chunks: string[] = [];
      const exits: number[] = [];
      session.onOutput((text) => chunks.push(text));
      session.onExit((code) => exits.push(code));

      await turns.next();
      expect(turns.ends).toEqual(['completed']);
      expect(chunks.some((chunk) => chunk.includes(marker)), session.getOutput()).toBe(true);
      expect(session.getOutput()).toMatch(/› Bash\(cat README\.md\)/);
      expect(turns.session.nativeSessionId()).toBeTruthy();

      session.kill();
      session.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exits).toHaveLength(1);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the task alive for the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      const session = await runner.spawn({
        taskId: 'live-interrupt',
        runner: 'claude-code',
        prompt: 'Use the Bash tool to run `sleep 60 && echo finished`, then summarize the result.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const started = new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));
      await started;

      await turns.session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(turns.session.turnState()).toBe('idle');

      turns.session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
