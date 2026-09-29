import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { HeadlessRunner, type SpawnFn } from '../HeadlessRunner';
import { StructuredRunner } from '../StructuredRunner';
import { TransportRouter } from '../TransportRouter';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { makeSession, taskOf } from './sessionTestKit';

/**
 * A whole structured run, live (ADR-0018): a Session wired the way the hosts
 * wire it, the setting on `structured`, and two Claude Code tasks where the
 * second depends on the first. Gated like `structuredLive.smoke.test.ts`:
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core structuredRunLive
 *
 * What it asserts is the run: task 1 passes on its marker, its process ends
 * with its verdict, and task 2's prompt carries task 1's summary.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'haiku';
const TIMEOUT_MS = 300_000;

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe.runIf(live)('structured run — live', () => {
  it('runs two dependent Claude Code tasks on the structured transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-run-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "structured-run" }\n');
    const children: ChildProcess[] = [];
    const spawn: SpawnFn = (command, args, options) => {
      const child = nodeSpawn(command, args, options);
      children.push(child);
      return child;
    };
    const router = new TransportRouter({ terminal: new HeadlessRunner(), structured: new StructuredRunner({ process: { spawn } }) });
    const prompts = new Map<string, string>();
    const runner = {
      get activeCount() { return router.activeCount; },
      spawn: (opts: RunnerSpawnOptions) => { prompts.set(opts.taskId, opts.prompt); return router.spawn(opts); },
      stop: vi.fn((id: string) => router.stop(id)),
      stopAll: () => router.stopAll(),
    };
    const session = makeSession({
      runner,
      workspaceRoot: () => dir,
      settings: () => ({ tddEnabled: false, runnerTransport: 'structured' }),
      taskOutput: new BufferedTaskOutputSource(),
    });
    const assignedModel = { modelId: model, modelLabel: model };
    const plan: LegacyPlanState = {
      tasks: [
        createTask({
          id: 'live-1', order: 1, title: 'Name the word', taskMode: 'acceptEdits', assignedModel,
          prompt: 'Do not use any tools. Reply with exactly this sentence: The secret word is PELICAN.',
        }),
        createTask({
          id: 'live-2', order: 2, title: 'Repeat the word', taskMode: 'acceptEdits', assignedModel, dependencies: ['live-1'],
          prompt: 'Do not use any tools. Say which secret word the earlier task named.',
        }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    try {
      session.loadPlan(plan, 'Structured run', dir);
      await session.executePlan();

      await vi.waitFor(() => expect(taskOf(session, 'live-1')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });
      const first = taskOf(session, 'live-1')!;
      expect(first.verdict?.outcome).toBe('pass');
      expect(first.verdict?.checks.find((c) => c.name === 'completion_marker')?.passed).toBe(true);
      expect(first.transport).toMatchObject({ kind: 'structured', nativeSessionId: expect.any(String) });
      expect(first.outputSummary?.logTail).toContain('PELICAN');
      await vi.waitFor(() => expect(exited(children[0])).toBe(true), { timeout: 10_000 });

      await vi.waitFor(() => expect(taskOf(session, 'live-2')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });
      expect(prompts.get('live-2')).toContain('PELICAN');
      await vi.waitFor(() => expect(children.every(exited)).toBe(true), { timeout: 10_000 });
    } finally {
      session.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS * 2);
});
