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

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

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
  it('leaves a tool request open for someone to answer, and passes the whole request on', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', effortArgs: [] } }));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '9a948184-6792-4049-85b1-3e837387f618',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/a.txt', content: 'a' }),
      input: { file_path: '/repo/a.txt', content: 'a' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseId: 'toolu_01TxT55eyjF5qKKGmJHwiDbe',
    });
    await tick();
    expect(spawned.processes[0].written).toHaveLength(1);
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    adapter.dispose();
  });

  it('answers Allow with the call\'s own input, then Allow for this task with Claude\'s own suggestions', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'permission-task'),
      fixture('claude-code', 'permission-task-allowed'),
      fixture('claude-code', 'permission-task-allowed-for-task'),
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', effortArgs: [] } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Write a.txt and b.txt', (e) => events.push(e));
    const requests = () => events.filter((e) => e.type === 'permission_request');

    await until(() => requests().length === 1);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(true);
    expect(JSON.parse(spawned.processes[0].written[1])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '9a948184-6792-4049-85b1-3e837387f618',
        response: { behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'a' } },
      },
    });

    await until(() => requests().length === 2);
    expect(adapter.answerPermission('5ab6f7de-9bb1-4e03-9e80-8c3aa64c0506', { decision: 'allowForTask' })).toBe(true);
    expect(JSON.parse(spawned.processes[0].written[2])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '5ab6f7de-9bb1-4e03-9e80-8c3aa64c0506',
        response: {
          behavior: 'allow',
          updatedInput: { file_path: '/repo/b.txt', content: 'b' },
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });

    await turn;
    // The recorded run: both writes went through, and the third call ran
    // unasked under the session-scoped grant.
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.success)).toEqual([true, true, true]);
    expect(requests()).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('answers Deny with the note as the message the agent reads', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task-deny'), fixture('claude-code', 'permission-task-denied')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', effortArgs: [] } }));
    const events: AgentEvent[] = [];
    void adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny', note: 'Not this one — write it to notes/c.txt instead.' })).toBe(true);
    expect(JSON.parse(spawned.processes[0].written[1])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '160adb6f-1e51-4d65-a12f-911f10dd46ae',
        response: { behavior: 'deny', message: 'Not this one — write it to notes/c.txt instead.' },
      },
    });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ success: false, output: 'Not this one — write it to notes/c.txt instead.' });
    adapter.dispose();
  });

  it('denies without a note in words of its own, since the CLI requires a message', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task-deny')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    void adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny', note: '   ' });
    const answer = JSON.parse(spawned.processes[0].written[1]) as { response: { response: { behavior: string; message: string } } };
    expect(answer.response.response.behavior).toBe('deny');
    expect(answer.response.response.message).toMatch(/\S/);
    adapter.dispose();
  });

  it('answers Allow for this task as a plain allow when Claude suggested nothing', async () => {
    const noSuggestions = fixture('claude-code', 'permission-task').replace(/,"permission_suggestions":\[[^\]]*\]/, '');
    const { spawned, processDeps } = deps([noSuggestions]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ suggestions: [] });
    adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allowForTask' });
    const answer = JSON.parse(spawned.processes[0].written[1]) as { response: { response: Record<string, unknown> } };
    expect(answer.response.response).toEqual({ behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'a' } });
    adapter.dispose();
  });

  it('answers each request once, and nothing it never asked', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(adapter.answerPermission('not-asked', { decision: 'allow' })).toBe(false);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(true);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny' })).toBe(false);
    expect(spawned.processes[0].written).toHaveLength(2);
    adapter.dispose();
  });

  it('reports a request Claude withdraws when the turn is interrupted, and takes no answer for it', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'permission-task-deny'),
      fixture('claude-code', 'permission-task-denied'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'permission-task-cancelled', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny' });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(events).toContainEqual({ type: 'permission_cancelled', id: '04436c5a-8682-477d-a23f-34bbb9f814f3' });
    expect(adapter.answerPermission('04436c5a-8682-477d-a23f-34bbb9f814f3', { decision: 'allow' })).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(spawned.processes[0].written).toHaveLength(3);
    adapter.dispose();
  });

  it('still denies a planner\'s request itself, at once, with nothing left open', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const events: AgentEvent[] = [];
    void adapter.send('Plan it', (e) => events.push(e));
    await until(() => spawned.processes[0].written.length === 2);
    const answer = JSON.parse(spawned.processes[0].written[1]) as { response: { response: { behavior: string } } };
    expect(answer.response.response.behavior).toBe('deny');
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '9a948184-6792-4049-85b1-3e837387f618',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/a.txt', content: 'a' }),
    });
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(false);
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
