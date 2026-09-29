import { describe, it, expect } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { width } from '../ansi';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import type { TaskLogState, TaskView, TuiState } from '../state';
import { messagesOf } from './chat';

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const structured = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'plan', tasks: [task({ transport: { kind: 'structured' } })], ...over });

const events: TaskLogEvent[] = [
  { type: 'turn_start', message: 'Do the task' },
  { type: 'text_delta', text: 'Hello from the runner.' },
  { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"npm test"}' },
  { type: 'tool_result', id: 'c1', output: 'ok', success: true },
  { type: 'turn_end', reason: 'completed' },
];

const loaded = (over: Partial<TaskLogState> = {}): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog(events),
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex: 0,
  ...over,
});

const notLoaded = (over: Partial<TaskLogState> = {}): TaskLogState =>
  loaded({ view: replayTaskLog([]), attempts: [], attempt: 0, loaded: false, ...over });

const opened = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', tasks: [task({ transport: { kind: 'structured' } })], taskView: loaded(), ...over });

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const accent = (state: TuiState): boolean => render(state).some((l) => l.includes('\x1b[94m'));
const key = (name: string, char?: string) => ({ name, ...(char ? { char } : {}) });

describe('opening and closing the task view', () => {
  it('t on a structured task opens it and reads the saved log', () => {
    const { state, effects } = reduce(structured(), { type: 'key', key: key('char', 't') });
    expect(state.taskView?.taskId).toBe('t1');
    expect(state.focus).toBe('chat');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('/terminal on a structured task opens it too', () => {
    const { state, effects } = run('/terminal 1', structured({ focus: 'chat' }));
    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
  });

  it('a terminal task still opens its OS terminal', () => {
    const terminal = initialState({ sessionId: 's1', focus: 'plan', tasks: [task({ transport: { kind: 'terminal' } })] });
    expect(reduce(terminal, { type: 'key', key: key('char', 't') }).effects).toEqual([
      { type: 'openTaskTerminal', sessionId: 's1', taskId: 't1' },
    ]);
  });

  it('esc clears a draft first, then closes back to the planner chat', () => {
    const withDraft = { ...opened(), editor: { ...opened().editor, text: 'half typed', cursor: 10 } };
    const cleared = reduce(withDraft, { type: 'key', key: key('escape') }).state;
    expect(cleared.taskView).not.toBeNull();
    expect(cleared.editor.text).toBe('');
    expect(reduce(cleared, { type: 'key', key: key('escape') }).state.taskView).toBeNull();
  });

  it('a new session drops the task view', () => {
    const { state } = reduce(opened(), { type: 'sessionCleared' });
    expect(state.taskView).toBeNull();
  });
});

describe('loading the log', () => {
  it('replays a saved attempt into the view', () => {
    const { state } = reduce(opened({ taskView: notLoaded() }), {
      type: 'taskLogLoaded', taskId: 't1', attempts: [1], attempt: 1, events, sessionId: 's1',
    });
    expect(state.taskView?.view.blocks.length).toBeGreaterThan(0);
    expect(state.taskView?.attempt).toBe(1);
  });

  it('folds live batches after the saved log', () => {
    const after = reduce(opened(), {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: ' More.' }], sessionId: 's1',
    }).state;
    const text = after.taskView!.view.blocks.filter((b) => b.type === 'message' && b.role === 'agent').at(-1);
    expect(text?.type === 'message' ? text.text : '').toContain('More.');
  });

  it('buffers a batch until the saved log lands, then drops the copy the file holds', () => {
    const loading = opened({ taskView: notLoaded() });
    const buffered = reduce(loading, {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: 'Hello' }], sessionId: 's1',
    }).state;
    expect(buffered.taskView!.view.blocks).toHaveLength(0);

    const caughtUp = reduce(buffered, {
      type: 'taskLogLoaded', taskId: 't1', attempts: [1], attempt: 1, events: [{ type: 'text_delta', text: 'Hello' }], sessionId: 's1',
    }).state;
    const agents = caughtUp.taskView!.view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0].type === 'message' ? agents[0].text : '').toBe('Hello');
  });

  it('applies a buffered batch for a retry that raced the log read', () => {
    const loading = opened({ taskView: notLoaded() });
    const buffered = reduce(loading, {
      type: 'taskLog', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }], sessionId: 's1',
    }).state;
    const caughtUp = reduce(buffered, {
      type: 'taskLogLoaded', taskId: 't1', attempts: [1], attempt: 1, events, sessionId: 's1',
    }).state;
    expect(caughtUp.taskView?.attempt).toBe(2);
    expect(caughtUp.taskView?.attempts).toEqual([1, 2]);
  });

  it('falls back to the live stream when the saved log cannot be read', () => {
    const loading = opened({ taskView: notLoaded() });
    const buffered = reduce(loading, {
      type: 'taskLog', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: 'Hello' }], sessionId: 's1',
    }).state;
    const failed = reduce(buffered, { type: 'failed', message: 'boom' }).state;
    expect(failed.taskView?.loaded).toBe(true);
    const agents = failed.taskView!.view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    expect(agents).toHaveLength(1);
  });

  it('ignores a batch for another task', () => {
    const before = opened();
    const state = reduce(before, {
      type: 'taskLog', taskId: 'other', attempt: 1, events: [{ type: 'text_delta', text: 'nope' }], sessionId: 's1',
    }).state;
    expect(state.taskView).toBe(before.taskView);
  });
});

describe('earlier attempts', () => {
  const twoAttempts = opened({ taskView: loaded({ attempts: [1, 2], attempt: 2 }) });

  it('alt-left asks for the earlier attempt and stops following the latest', () => {
    const { state, effects } = reduce(twoAttempts, { type: 'key', key: key('alt-left') });
    expect(effects).toEqual([{ type: 'loadTaskAttempt', sessionId: 's1', taskId: 't1', attempt: 1 }]);
    expect(state.taskView?.followLatest).toBe(false);
  });

  it('alt-left at the first attempt says so instead of loading', () => {
    const first = opened({ taskView: loaded({ attempts: [1], attempt: 1 }) });
    const { state, effects } = reduce(first, { type: 'key', key: key('alt-left') });
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
  });

  it('a live batch for a newer attempt is recorded, not forced onto a pinned view', () => {
    const pinned = opened({ taskView: loaded({ attempts: [1], attempt: 1, followLatest: false }) });
    const state = reduce(pinned, {
      type: 'taskLog', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }], sessionId: 's1',
    }).state;
    expect(state.taskView?.attempt).toBe(1);
    expect(state.taskView?.attempts).toEqual([1, 2]);
  });
});

describe('talking to the task', () => {
  it('submitting sends the message instead of reaching the planner', () => {
    const { state, effects } = run('use Postgres', opened({ focus: 'chat' }));
    expect(effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'use Postgres' }]);
    expect(state.editor.text).toBe('');
  });

  it('ctrl-r removes the selected queued message', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([
          ...events,
          { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
          { type: 'message_queued', messageId: 'm2', text: 'also tests' },
        ]),
        queuedIndex: 1,
      }),
    });
    const { effects } = reduce(queued, { type: 'key', key: key('ctrl-r') });
    expect(effects).toEqual([{ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
  });

  it('ctrl-n walks the queue selection, ctrl-p walks it back', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([{ type: 'message_queued', messageId: 'm1', text: 'one' }, { type: 'message_queued', messageId: 'm2', text: 'two' }]),
        queuedIndex: 0,
      }),
    });
    const down = reduce(queued, { type: 'key', key: key('ctrl-n') }).state;
    expect(down.taskView?.queuedIndex).toBe(1);
    expect(reduce(down, { type: 'key', key: key('ctrl-p') }).state.taskView?.queuedIndex).toBe(0);
  });

  it('ctrl-x interrupts the running turn', () => {
    const { effects } = reduce(opened(), { type: 'key', key: key('ctrl-x') });
    expect(effects).toEqual([{ type: 'interruptTask', sessionId: 's1', taskId: 't1' }]);
  });

  it('shows queued messages, the selected one highlighted', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([{ type: 'message_queued', messageId: 'm1', text: 'use Postgres' }]),
        queuedIndex: 0,
      }),
    });
    const out = plain(queued);
    expect(out).toContain('use Postgres');
    expect(out).toContain('queued');
    expect(out).toContain('ctrl-r removes');
  });
});

describe('the task view draws as a runner, not the planner', () => {
  it('takes the accent on the header and the pane border', () => {
    const out = render(opened());
    expect(accent(opened())).toBe(true);
    expect(out.join('\n')).toContain('\x1b[94m');
  });

  it('names the task, its runner and its live state in the header', () => {
    const out = plain(opened());
    expect(out).toContain('→ Task 1');
    expect(out).toContain('Refactor PlanStore');
    expect(out).toContain('claude-code');
    expect(out).toContain('working');
    expect(out).toContain('ctrl-r remove queued');
    expect(out).toContain('ctrl-x interrupt');
  });

  it('says what an awaiting task waits on', () => {
    const waiting = opened({
      tasks: [task({ transport: { kind: 'structured' }, status: 'awaiting_user', awaitingReason: 'input' })],
      taskView: loaded({ view: replayTaskLog([]) }),
    });
    expect(plain(waiting)).toContain('waiting for your input');
  });

  it('labels the composer with the task number', () => {
    expect(plain(opened())).toContain('→ Task 1');
    expect(plain(opened({ taskView: null }))).not.toContain('→ Task 1');
  });

  it('shows the usage line from the log', () => {
    const withUsage = opened({
      taskView: loaded({
        view: replayTaskLog([
          { type: 'turn_start', message: 'x' },
          { type: 'usage', record: { source: 'claude-code', inputTokens: 12400, outputTokens: 3100 } },
        ]),
      }),
    });
    expect(plain(withUsage)).toContain('12.4k in');
  });

  it('draws the tool call and its result', () => {
    const out = plain(opened());
    expect(out).toContain('Bash');
    expect(out).toContain('ok');
  });

  it('never overruns the terminal, at every width', () => {
    const queued = opened({
      taskView: loaded({
        view: replayTaskLog([
          ...events,
          { type: 'message_queued', messageId: 'm1', text: 'a queued message that is quite long and should wrap' },
        ]),
      }),
    });
    for (const cols of [40, 60, 80, 120, 200]) {
      const frame = render({ ...queued, cols, rows: 20 });
      expect(frame).toHaveLength(20);
      for (const line of frame) {
        expect(line.includes('\n')).toBe(false);
        expect(width(line)).toBeLessThanOrEqual(cols);
      }
    }
  });
});

describe('continuing a finished task (ADR-0018, K1)', () => {
  const finished = (over: Partial<TaskView> = {}) =>
    opened({ focus: 'chat', tasks: [task({ status: 'completed', transport: { kind: 'structured' }, continuable: true, ...over })] });

  it('labels the composer as a continue', () => {
    expect(plain(finished())).toContain('→ Continue task 1');
    expect(plain(opened())).not.toContain('Continue task');
    expect(plain(finished({ continuable: false }))).not.toContain('Continue task');
  });

  it('submitting continues the task, following the new attempt, instead of messaging a turn', () => {
    const pinned = { ...finished(), taskView: loaded({ attempts: [1, 2], attempt: 1, followLatest: false }) };
    const { state, effects } = run('also handle arrays', pinned);

    expect(effects).toEqual([{ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'also handle arrays', watch: true }]);
    expect(state.taskView?.followLatest).toBe(true);
    expect(state.editor.text).toBe('');
  });

  it('does not watch a second stream while a run is already executing', () => {
    const { effects } = run('go on', { ...finished(), status: 'executing' });
    expect(effects).toEqual([{ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'go on' }]);
  });

  it('a started continue is messaged, not continued twice, even before the flag clears', () => {
    const { effects } = run('use Postgres', finished({ status: 'in_progress' }));
    expect(effects).toEqual([{ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'use Postgres' }]);
  });

  it('/continue <id> <message> opens the task\'s view and continues it', () => {
    const planner = initialState({ sessionId: 's1', focus: 'chat', tasks: [task({ status: 'failed', transport: { kind: 'structured' }, continuable: true })] });
    const { state, effects } = run('/continue 1 the tests need Node 22', planner);

    expect(state.taskView?.taskId).toBe('t1');
    expect(effects).toEqual([
      { type: 'openTaskLog', sessionId: 's1', taskId: 't1' },
      { type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'the tests need Node 22', watch: true },
    ]);
  });

  it('/continue without a message says how to use it', () => {
    const { state, effects } = run('/continue 1', finished());
    expect(effects).toEqual([]);
    expect(messagesOf(state).at(-1)?.text).toBe('Usage: /continue <id> <message>');
  });

  it('keeps the continuable flag in step with the daemon\'s status', () => {
    const base = initialState({ sessionId: 's1', tasks: [task({ status: 'completed', transport: { kind: 'structured' } })] });
    const on = reduce(base, { type: 'tasksStatus', sessionId: 's1', updates: { t1: { status: 'completed', transport: { kind: 'structured' }, continuable: true } } }).state;
    expect(on.tasks[0].continuable).toBe(true);
    const off = reduce(on, { type: 'tasksStatus', sessionId: 's1', updates: { t1: { status: 'in_progress', transport: { kind: 'structured' } } } }).state;
    expect(off.tasks[0].continuable).toBe(false);
  });
});
