import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import type { GateView, HandoffView, TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const apply = (state: TuiState, action: Action): Step => reduce(state, action);
const frame = (state: TuiState): string => render(state).join('\n');

const handoff: HandoffView = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abcdef1234567890', landed: [{ taskId: 't1', order: 1, title: 'Bump the version' }] }],
  landed: [{ taskId: 't1', order: 1, title: 'Bump the version' }],
};
const gate: GateView = { paused: true, handoff };

const change = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Bump the version', type: 'ai', status: 'completed', dependencies: [], ...over,
});
const deploy = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'o2', order: 2, title: 'Redeploy on dev', type: 'ai', status: 'pending', dependencies: ['t1'], ops: true, ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 40, cols: 100, focus: 'plan', tasks, ...over });

describe('ops tasks and merge gates in the TUI (ADR-0020)', () => {
  it('marks an ops task, and a task waiting at its merge gate', () => {
    const out = frame(plan([change(), deploy({ mergeGate: ['t1'] })]));

    expect(out).toContain('OPS Redeploy on dev');
    expect(out).toContain('⏸ waits for Merge all — #1');
  });

  it('takes the gate from a status update, and says the run is paused for Merge all', () => {
    const state = plan([change(), deploy()], { status: 'executing' });

    const next = apply(state, { type: 'tasksStatus', sessionId: 's1', gate, updates: { o2: { status: 'pending', idleSince: null, mergeGate: ['t1'] } } }).state;

    expect(next.gate).toEqual(gate);
    expect(next.tasks[1].mergeGate).toEqual(['t1']);
    expect(next.status).toBe('executing');
    expect(next.busyLabel).toBe('paused for Merge all — /handoff merge');

    const cleared = apply(next, { type: 'tasksStatus', sessionId: 's1', gate: null, updates: { o2: { status: 'in_progress', idleSince: null } } }).state;
    expect(cleared.gate).toBeNull();
    expect(cleared.tasks[1].mergeGate).toBeUndefined();
  });

  it('flips a task between change and ops with O', () => {
    const state = plan([change({ status: 'pending' })]);

    expect(press(state, 'char', 'O').effects).toEqual([{
      type: 'updateTask', sessionId: 's1', taskId: 't1', changes: { ops: true },
      message: 'Task #1 is an ops task: it runs in your checkout once the work it depends on is merged.',
    }]);
    expect(press(plan([deploy()]), 'char', 'O').effects).toMatchObject([{ changes: { ops: false } }]);
  });

  it('refuses O on a manual task', () => {
    const step = press(plan([change({ type: 'user' })]), 'char', 'O');
    expect(step.effects).toEqual([]);
  });

  it('asks before a force start passes a merge gate, naming what is not merged', () => {
    const state = plan([change(), deploy({ mergeGate: ['t1'] })], { selectedTask: 1 });

    const asked = press(state, 'char', 'f');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'force-start-gated', taskId: 'o2' } });
    expect(asked.state.overlay?.kind === 'confirm' && asked.state.overlay.message).toContain('#1 Bump the version is not merged');
    expect(press(asked.state, 'enter').effects).toMatchObject([{ type: 'taskAction', taskId: 'o2', action: 'force-start' }]);
  });

  it('offers Merge all mid-run from the gate, and keeps the run when it merges', () => {
    const state = plan([change(), deploy({ mergeGate: ['t1'] })], { status: 'executing', gate, focus: 'chat' });

    const typed = reduce({ ...state, editor: { ...state.editor, text: '/handoff merge', cursor: 14 } }, key('enter'));

    expect(typed.state.overlay).toMatchObject({ kind: 'confirm', title: 'Merge what has landed into your branch?' });
    expect(typed.state.overlay?.kind === 'confirm' && typed.state.overlay.message).toContain('The run goes on');
    expect(press(typed.state, 'enter').effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', midRun: true }]);
  });
});
