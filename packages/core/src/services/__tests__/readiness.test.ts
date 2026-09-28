import { describe, it, expect } from 'vitest';
import { selectReadyTasks, isBlocked, dependencyMet, type ReadinessInput } from '../readiness';
import { createTask, type Task } from '../../models/Task';
import type { IsolationTaskRecord, IsolationTaskStatus } from '../../interfaces/IWorktreeIsolation';

function storeOf(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    allTasks: tasks as ReadonlyArray<Readonly<Task>>,
    isCompleted: (id: string) => byId.get(id)?.status === 'completed',
    isFailed: (id: string) => byId.get(id)?.status === 'failed',
  };
}

function record(taskId: string, status: IsolationTaskStatus): IsolationTaskRecord {
  return { taskId, order: 1, title: taskId, branch: `b/${taskId}`, workspace: `/wt/${taskId}`, status, repos: {} };
}

function runsOf(records: Record<string, IsolationTaskRecord> = {}) {
  return { openRecord: (taskId: string) => records[taskId] };
}

function input(tasks: Task[], overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    store: storeOf(tasks),
    onHold: new Set(),
    runs: runsOf(),
    active: 0,
    maxParallel: 3,
    ...overrides,
  };
}

describe('selectReadyTasks', () => {
  it('offers pending AI tasks with a prompt, lowest order first', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' });

    const { ready, candidateCount } = selectReadyTasks(input([t2, t1]));

    expect(ready.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(candidateCount).toBe(2);
  });

  it.each([
    ['user task', createTask({ id: 'u1', order: 1, title: 'Check', type: 'user' })],
    ['promptless AI task', createTask({ id: 'a1', order: 2, title: 'Later' })],
    ['completed task', createTask({ id: 'c1', order: 3, title: 'Done', prompt: 'x', status: 'completed' })],
  ])('holds back a %s', (_label, task) => {
    const { ready, excluded } = selectReadyTasks(input([task]));

    expect(ready).toHaveLength(0);
    // A promptless or user task is not an AI task with work the log should name.
    if (task.type === 'ai' && task.prompt) expect(excluded.map((e) => e.task.id)).toEqual([task.id]);
    else expect(excluded).toHaveLength(0);
  });

  it('names every reason a pending AI task was passed over', () => {
    const held = createTask({ id: 'h1', order: 1, title: 'Held', prompt: 'x' });
    const parked = createTask({ id: 'b1', order: 2, title: 'Parked', prompt: 'x', status: 'blocked' });
    const dep = createTask({ id: 'd1', order: 3, title: 'Dep', prompt: 'x', dependencies: ['missing'] });

    const { ready, excluded } = selectReadyTasks(input([held, parked, dep], { onHold: new Set(['h1']) }));

    expect(ready).toHaveLength(0);
    expect(excluded.find((e) => e.task.id === 'h1')!.reasons).toEqual(['on-hold']);
    expect(excluded.find((e) => e.task.id === 'b1')!.reasons).toEqual(['status=blocked', 'blocked']);
    expect(excluded.find((e) => e.task.id === 'd1')!.reasons).toEqual(['deps']);
  });

  it('does not start a dependent until its dependency has completed', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    const { ready, excluded } = selectReadyTasks(input([t1, t2]));
    expect(ready.map((t) => t.id)).toEqual(['t1']);
    expect(excluded.find((e) => e.task.id === 't2')!.reasons).toEqual(['deps']);
  });

  it('frees a dependent once its dependency completed', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', status: 'completed' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    expect(selectReadyTasks(input([t1, t2])).ready.map((t) => t.id)).toEqual(['t2']);
  });

  it('blocks a dependent whose dependency failed', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', status: 'failed' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    const { excluded } = selectReadyTasks(input([t1, t2]));
    expect(isBlocked(t2, storeOf([t1, t2]))).toBe(true);
    expect(excluded.find((e) => e.task.id === 't2')!.reasons).toEqual(['blocked', 'deps']);
  });

  it('waits for a dependency to land before starting a dependent in an isolated run', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', status: 'completed' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });

    const unlanded = selectReadyTasks(input([t1, t2], { runs: runsOf({ t1: record('t1', 'active') }) }));
    expect(unlanded.ready).toHaveLength(0);
    expect(unlanded.excluded.find((e) => e.task.id === 't2')!.reasons).toEqual(['deps']);

    const landed = selectReadyTasks(input([t1, t2], { runs: runsOf({ t1: record('t1', 'merged') }) }));
    expect(landed.ready.map((t) => t.id)).toEqual(['t2']);
  });

  it('offers nothing when the slots are already full', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });

    const { ready, candidateCount, excluded } = selectReadyTasks(input([t1], { active: 1, maxParallel: 1 }));

    expect(ready).toHaveLength(0);
    expect(candidateCount).toBe(0);
    expect(excluded).toHaveLength(0);
  });

  it('caps the offered tasks at the free slots but counts every candidate', () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' });

    const { ready, candidateCount } = selectReadyTasks(input([t1, t2], { maxParallel: 1 }));

    expect(ready.map((t) => t.id)).toEqual(['t1']);
    expect(candidateCount).toBe(2);
  });
});

describe('dependencyMet', () => {
  const completed = storeOf([createTask({ id: 't1', order: 1, title: 'First', prompt: 'x', status: 'completed' })]);
  const pending = storeOf([createTask({ id: 't1', order: 1, title: 'First', prompt: 'x' })]);

  it('is unmet while the dependency has not completed', () => {
    expect(dependencyMet('t1', pending, runsOf())).toBe(false);
  });

  it('is met once the dependency completed and no isolation run gates it', () => {
    expect(dependencyMet('t1', completed, runsOf())).toBe(true);
  });

  it('is unmet until the isolated dependency has merged', () => {
    expect(dependencyMet('t1', completed, runsOf({ t1: record('t1', 'conflict') }))).toBe(false);
    expect(dependencyMet('t1', completed, runsOf({ t1: record('t1', 'merged') }))).toBe(true);
  });
});

describe('isBlocked', () => {
  it('reads a parked status on its own', () => {
    const task = createTask({ id: 't1', order: 1, title: 'Parked', prompt: 'x', status: 'blocked' });
    expect(isBlocked(task, storeOf([task]))).toBe(true);
  });

  it('reads a failed dependency', () => {
    const failed = createTask({ id: 't1', order: 1, title: 'Failed', prompt: 'x', status: 'failed' });
    const dependent = createTask({ id: 't2', order: 2, title: 'Dependent', prompt: 'x', dependencies: ['t1'] });
    expect(isBlocked(dependent, storeOf([failed, dependent]))).toBe(true);
  });

  it('does not block a task without dependencies', () => {
    const task = createTask({ id: 't1', order: 1, title: 'Free', prompt: 'x' });
    expect(isBlocked(task, storeOf([task]))).toBe(false);
  });
});
