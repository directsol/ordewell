import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { TaskModeUnsupportedError, type AgentEvent, type AgentProcessDeps, type TaskStartOptions } from '../harness/AgentAdapter';
import { supportsTaskMode, createTaskAdapter } from '../harness/taskAdapters';
import { fakeSpawn, fixture, type ScriptedReply } from './harnessTestKit';

/**
 * The adapter's task mode (ADR-0018, C1), against transcripts recorded from
 * `claude` 2.1.284 in `-p` stream-json mode. The planner's read-only start is
 * asserted here too, flag for flag: task mode must not have moved it.
 */

function deps(replies: ScriptedReply[]) {
  const spawned = fakeSpawn(replies);
  const processDeps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  return { spawned, processDeps };
}

function taskStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo',
    mode: 'acceptEdits',
    flags: { permissionMode: 'acceptEdits', effortArgs: [] },
    ...overrides,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ClaudeCodeAdapter start switch', () => {
  it('starts a planner with exactly the read-only flags it always had', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', model: 'sonnet', effort: 'high', resumeSessionId: 'sess-1' });
    expect(spawned.lastCommand()).toBe('claude');
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'plan',
      '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,KillShell',
      '--append-system-prompt', 'PLAN',
      '--model', 'sonnet',
      '--effort', 'high',
      '--resume', 'sess-1',
    ]);
    adapter.dispose();
  });

  it('starts a task with the protocol flags around the manifest-derived ones, and nothing of the planner', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({
      model: 'opus',
      resumeSessionId: 'sess-9',
      flags: { permissionMode: 'default', effortArgs: ['--thinking', 'enabled', '--effort', 'max'] },
    }));
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default',
      '--thinking', 'enabled', '--effort', 'max',
      '--model', 'opus',
      '--resume', 'sess-9',
    ]);
    adapter.dispose();
  });
});

describe('task mode support', () => {
  it('is Claude Code alone for now', () => {
    expect(supportsTaskMode('claude-code')).toBe(true);
    expect(supportsTaskMode('codex')).toBe(false);
    expect(supportsTaskMode('opencode')).toBe(false);
    expect(supportsTaskMode('toString')).toBe(false);
    expect(() => createTaskAdapter('codex', deps([]).processDeps)).toThrow(TaskModeUnsupportedError);
  });

  it.each([
    ['codex', (d: AgentProcessDeps) => new CodexAdapter(d)],
    ['opencode', (d: AgentProcessDeps) => new OpenCodeAdapter(d)],
  ])('%s refuses task mode with a typed error and spawns nothing', async (runner, make) => {
    const { spawned, processDeps } = deps([]);
    const started = make(processDeps).start(taskStart());
    await expect(started).rejects.toBeInstanceOf(TaskModeUnsupportedError);
    await expect(started).rejects.toThrow(`${runner} has no structured task connector yet`);
    expect(spawned.processes).toHaveLength(0);
  });
});

describe('ClaudeCodeAdapter in task mode', () => {
  it('still denies a tool request, but passes the whole request on', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-permission'), fixture('claude-code', 'task-permission-after-deny')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', effortArgs: [] } }));
    const events: AgentEvent[] = [];
    await adapter.send('Write notes.txt', (e) => events.push(e));

    const request = events.find((e) => e.type === 'permission_request');
    expect(request).toEqual({
      type: 'permission_request',
      id: 'c5ba4691-a850-402b-a475-a9513770ebbb',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/notes.txt', content: 'hi' }),
      input: { file_path: '/repo/notes.txt', content: 'hi' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseId: 'toolu_014wFqd7q2wd1RXyFn21E3Fs',
    });
    const answer = JSON.parse(spawned.processes[0].written[1]) as { response: { request_id: string; response: { behavior: string } } };
    expect(answer.response.request_id).toBe('c5ba4691-a850-402b-a475-a9513770ebbb');
    expect(answer.response.response.behavior).toBe('deny');
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('interrupts with the control request the CLI acknowledges, and the turn ends interrupted', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'task-interrupt'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('sleep a while', (e) => events.push(e));
    await tick();

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(JSON.parse(spawned.processes[0].written[1])).toEqual({
      type: 'control_request',
      request_id: 'ordewell-interrupt-1',
      request: { subtype: 'interrupt' },
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    adapter.dispose();
  });

  it('reports an unanswered interrupt so the caller can fall back', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-interrupt')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    void adapter.send('sleep a while', () => {});
    await tick();
    await expect(adapter.interrupt(20)).resolves.toBe(false);
    adapter.dispose();
  });

  it('reports a process that ends, once', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const codes: number[] = [];
    adapter.onProcessExit((code) => codes.push(code));
    spawned.processes[0].exit(3);
    spawned.processes[0].exit(3);
    await tick();
    expect(codes).toEqual([3]);
  });
});
