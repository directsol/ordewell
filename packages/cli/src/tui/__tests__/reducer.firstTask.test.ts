import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { planPaneWidth } from '../geometry';
import type { TuiState } from '../state';

const press = (state: TuiState, name: string, char?: string) =>
  reduce(state, { type: 'key', key: { name, char } });
const submit = (state: TuiState, text: string) =>
  reduce({ ...state, focus: 'chat', editor: { ...state.editor, text, cursor: text.length } }, {
    type: 'key',
    key: { name: 'enter' },
  });

const emptyPlan = (over: Partial<TuiState> = {}) =>
  initialState({ sessionId: 's1', cols: 120, rows: 30, selectedTask: 0, ...over });

const planWithOne = {
  tasks: [{ id: 't1', order: 1, title: 'Foo', type: 'ai', status: 'pending', dependencies: [] }],
};

describe('first task on an empty plan', () => {
  it('/add-task shows the task, reveals the pane and selects it', () => {
    const asked = submit(emptyPlan(), '/add-task Foo');
    expect(asked.effects).toEqual([{ type: 'addTask', sessionId: 's1', title: 'Foo' }]);
    expect(planPaneWidth(asked.state)).toBe(0);

    const { state } = reduce(asked.state, { type: 'planUpdated', plan: planWithOne });
    expect(state.tasks.map((t) => t.title)).toEqual(['Foo']);
    expect(planPaneWidth(state)).toBeGreaterThan(0);
    expect(state.selectedTask).toBe(0);
  });

  it('/add-task with no title prompts, and submitting the title adds it', () => {
    const asked = submit(emptyPlan(), '/add-task');
    expect(asked.state.overlay).toMatchObject({ kind: 'prompt', action: { kind: 'add-task' } });
    const typed = press(asked.state, 'char', 'F').state;
    const done = press(typed, 'enter');
    expect(done.effects).toEqual([{ type: 'addTask', sessionId: 's1', title: 'F' }]);
  });

  it('with no session, /add-task says what to do', () => {
    const { state, effects } = submit(initialState({ cols: 120 }), '/add-task Foo');
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.content).toMatch(/describe a goal first, then \/add-task <title>/);
  });

  it('the plan-pane `a` key opens the prompt with zero tasks', () => {
    const { state } = press(emptyPlan({ focus: 'plan' }), 'char', 'a');
    expect(state.overlay).toMatchObject({ kind: 'prompt', action: { kind: 'add-task' } });
  });

  it('tab stays in chat while the plan has no tasks', () => {
    expect(press(emptyPlan({ focus: 'chat' }), 'tab').state.focus).toBe('chat');
  });

  it('focus returns to chat when the last task goes away', () => {
    const filled = emptyPlan({ focus: 'plan', ...planWithOne } as Partial<TuiState>);
    const { state } = reduce(filled, { type: 'planUpdated', plan: { tasks: [] } });
    expect(state.focus).toBe('chat');
    expect(state.selectedTask).toBe(0);
  });

  it('down on an empty plan never goes negative', () => {
    expect(press(emptyPlan({ focus: 'plan' }), 'down').state.selectedTask).toBe(0);
  });
});
