import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { TaskModeUnsupportedError, type AgentEvent, type AgentProcessDeps, type AgentStartOptions, type TaskStartOptions } from '../harness/AgentAdapter';
import { supportsTaskMode, createTaskAdapter } from '../harness/taskAdapters';
import { resolveArgs, resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
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
    flags: { permissionMode: 'acceptEdits', modeSettings: {} },
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

  it.each([
    ['nothing else', {}],
    ['a model, an effort and a resume', { model: 'opus', effort: 'max', resumeSessionId: 'sess-1' }],
    // Task fields smuggled onto a planner start: nothing on the planner path reads them.
    ['a task\'s bypass mode and flags', { mode: 'bypassPermissions', flags: { permissionMode: 'bypassPermissions', effort: 'max', modeSettings: {} } }],
    ['the legacy build alias a task resolves to acceptEdits', { mode: 'build', flags: { permissionMode: 'acceptEdits', modeSettings: {} } }],
  ])('starts a planner read-only whatever else its start carries: %s', async (_label, extra) => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', ...extra } as unknown as AgentStartOptions);
    const args = spawned.lastArgs();

    expect(args.flatMap((arg, i) => (arg === '--permission-mode' ? [args[i + 1]] : []))).toEqual(['plan']);
    expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell']);
    for (const flag of ['--permission-prompt-tool', '--dangerously-skip-permissions', 'acceptEdits', 'bypassPermissions']) {
      expect(args).not.toContain(flag);
    }
    adapter.dispose();
  });

  it('starts a task with the protocol flags around the manifest-derived ones, and nothing of the planner', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({
      model: 'opus',
      resumeSessionId: 'sess-9',
      flags: { permissionMode: 'default', effort: 'max', modeSettings: {} },
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

/**
 * The adapter maps the task's raw effort itself now; the argv a Claude task
 * starts with, and its parity with the terminal command line, must not move.
 */
describe('ClaudeCodeAdapter task argv for every effort and mode', () => {
  const thinking: Array<[string, string[]]> = [
    ['adaptive', ['--thinking', 'adaptive']],
    ['low', ['--thinking', 'enabled', '--effort', 'low']],
    ['medium', ['--thinking', 'enabled', '--effort', 'medium']],
    ['high', ['--thinking', 'enabled', '--effort', 'high']],
    ['xhigh', ['--thinking', 'enabled', '--effort', 'xhigh']],
    ['max', ['--thinking', 'enabled', '--effort', 'max']],
    ['disabled', ['--thinking', 'disabled']],
    // A legacy variant id an old task may still carry.
    ['thinking-16k', ['--thinking', 'adaptive']],
  ];
  const modes: Array<[string, string]> = [
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'plan'],
    ['bypassPermissions', 'bypassPermissions'],
    ['build', 'acceptEdits'],
  ];
  const cases = modes.flatMap(([mode, permissionMode]) => [
    ...thinking.map(([effort, thinkingArgs]) => ({ mode, permissionMode, effort, model: 'sonnet' as string | undefined, thinkingArgs })),
    // Effort only rides with a model, on both transports.
    { mode, permissionMode, effort: 'max', model: undefined, thinkingArgs: [] },
  ]);

  async function taskArgs(mode: string, model: string | undefined, effort: string): Promise<string[]> {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode, model, flags: resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode, model, thinkingEffort: effort }) }));
    adapter.dispose();
    return spawned.lastArgs();
  }

  it.each(cases)('mode $mode, effort $effort, model $model', async ({ mode, permissionMode, effort, model, thinkingArgs }) => {
    expect(await taskArgs(mode, model, effort)).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', permissionMode,
      ...thinkingArgs,
      ...(model ? ['--model', model] : []),
    ]);
  });

  it.each(cases)('runs under the terminal template\'s flags: mode $mode, effort $effort, model $model', async ({ mode, effort, model }) => {
    const terminal = resolveArgs(CLAUDE_CODE_MANIFEST, { prompt: 'go', mode, model, thinkingEffort: effort }).args;
    const structured = await taskArgs(mode, model, effort);
    const valueOf = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    for (const flag of ['--permission-mode', '--thinking', '--effort', '--model']) {
      expect(valueOf(structured, flag)).toBe(valueOf(terminal, flag));
    }
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
  it('reports a resume the CLI cannot find as a failed turn in its own words, and lets the process go (ADR-0018, K1)', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }));
    const proc = spawned.processes[0];
    const events: AgentEvent[] = [];
    const turn = adapter.send('also handle arrays', (e) => events.push(e));
    // Recorded from `claude` 2.1.284: the refusal arrives on its own, before any `init`.
    proc.emitStdout(fixture('claude-code', 'task-resume-not-found'));
    await turn;

    expect(events).toEqual([{ type: 'error', message: 'No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }]);
    // The CLI waits on stdin after refusing; closing it is what lets it exit.
    expect(proc.stdinEnded).toBe(true);
    // No session was taken up, so none is announced for a later continue.
    expect(adapter.nativeSessionId()).toBeNull();
    adapter.dispose();
  });

  it('refused before any turn opens, the next turn reports the CLI\'s last words instead of hanging', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }));
    const proc = spawned.processes[0];
    proc.emitStderr('No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11\n');
    proc.emitStdout(fixture('claude-code', 'task-resume-not-found'));
    expect(proc.stdinEnded).toBe(true);
    proc.exit(1);

    const events: AgentEvent[] = [];
    await adapter.send('also handle arrays', (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('No conversation found with session ID') });
    expect(adapter.nativeSessionId()).toBeNull();
    adapter.dispose();
  });

  it('takes a resumed session up once the CLI announces it', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-marker')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: 'sess-task-marker' }));
    const events: AgentEvent[] = [];
    await adapter.send('go on', (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(spawned.processes[0].stdinEnded).toBe(false);
    expect(adapter.nativeSessionId()).toBe('sess-task-marker');
    adapter.dispose();
  });

  it('leaves a tool request open for someone to answer, and passes the whole request on', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
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
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
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
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
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
