import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import type { TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', ...over,
});

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
// A fixed workspace: the status bar prints it, and a checkout path can itself say "structured".
const planState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 20, cols: 180, focus: 'plan', workspace: '/repo', ...over });

describe('/transport', () => {
  it.each(['terminal', 'structured'] as const)('/transport %s sets it through the daemon', (transport) => {
    expect(run(`/transport ${transport}`).effects).toEqual([{ type: 'setTransport', transport }]);
  });

  it('a bare /transport flips whatever is set', () => {
    expect(run('/transport').effects).toEqual([{ type: 'setTransport', transport: 'structured' }]);
    expect(run('/transport', { runnerTransport: 'structured' }).effects).toEqual([{ type: 'setTransport', transport: 'terminal' }]);
  });

  it('refuses a transport that does not exist', () => {
    const { state, effects } = run('/transport telepathy');
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toContain('Usage: /transport [terminal|structured]');
  });

  it('follows the setting the daemon reports', () => {
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { runnerTransport: 'structured' } });
    expect(state.runnerTransport).toBe('structured');
  });
});

describe('a structured task opens its log, not a terminal', () => {
  const structured = initialState({ sessionId: 's1', focus: 'plan', tasks: [task({ transport: { kind: 'structured' } })] });

  it('t opens the task view and reads its saved log', () => {
    const { state, effects } = reduce(structured, { type: 'key', key: { name: 'char', char: 't' } });
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
    expect(state.taskView?.taskId).toBe('t1');
  });

  it('/terminal opens the task view too', () => {
    const { state, effects } = run('/terminal t1', { ...structured, focus: 'chat' });
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }]);
    expect(state.taskView?.taskId).toBe('t1');
  });

  it('a task that fell back still opens its terminal', () => {
    const fellBack = initialState({ sessionId: 's1', focus: 'plan', tasks: [task({ transport: { kind: 'terminal', fallback: 'no structured connector for Codex yet' } })] });
    expect(reduce(fellBack, { type: 'key', key: { name: 'char', char: 't' } }).effects).toEqual([
      { type: 'openTaskTerminal', sessionId: 's1', taskId: 't1' },
    ]);
  });
});

describe('the task row', () => {
  it('names the structured transport', () => {
    expect(plain(planState({ tasks: [task({ transport: { kind: 'structured' } })] }))).toContain('working · claude-code · structured');
  });

  it('does not point a quiet structured task at a terminal it lacks', () => {
    const out = plain(planState({ tasks: [task({ transport: { kind: 'structured' }, idleSince: '2026-09-29T00:00:00.000Z' })] }));
    expect(out).toContain('quiet · claude-code · structured');
    expect(out).not.toContain('t opens its terminal');
  });

  it('says why a task fell back to the terminal', () => {
    const out = plain(planState({ tasks: [task({ assignedRunner: 'codex', transport: { kind: 'terminal', fallback: 'no structured connector for Codex yet' } })] }));
    expect(out).toContain('terminal: no structured connector for Codex yet');
  });

  it('says nothing about transport on a terminal plan', () => {
    const out = plain(planState({ tasks: [task()] }));
    expect(out).not.toContain('structured');
    expect(out).not.toContain('terminal:');
  });

  it('takes the transport from each status update, and drops it when a later one has none', () => {
    const base = initialState({ sessionId: 's1', tasks: [task()] });
    const on = reduce(base, { type: 'tasksStatus', updates: { t1: { status: 'in_progress', transport: { kind: 'structured' } } }, sessionId: 's1' }).state;
    expect(on.tasks[0].transport).toEqual({ kind: 'structured' });
    const off = reduce(on, { type: 'tasksStatus', updates: { t1: { status: 'in_progress' } }, sessionId: 's1' }).state;
    expect(off.tasks[0].transport).toBeUndefined();
  });

  it('shows a structured badge beside the toggles only while the setting is on', () => {
    expect(plain(planState({ runnerTransport: 'structured' }))).toContain('● structured');
    expect(plain(planState())).not.toContain('structured');
  });
});
