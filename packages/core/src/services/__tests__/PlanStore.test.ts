import { describe, it, expect, beforeEach } from 'vitest';
import { PlanStore } from '../PlanStore';
import { createTask } from '../../models/Task';
import type { Task, TaskSnapshot } from '../../models/Task';

function makeSnapshot(taskId: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const task = createTask({ id: taskId, title: taskId });
  return {
    ...task,
    completedAt: 1700000000000,
    retryCount: 0,
    finalized: false,
    ...overrides,
  };
}

describe('PlanStore execution log', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('starts with an empty execution log', () => {
    expect(store.getExecutionLog()).toEqual([]);
  });

  describe('appendToLog', () => {
    it('appends a snapshot to the log', () => {
      const snap = makeSnapshot('task-1');
      store.appendToLog(snap);
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].id).toBe('task-1');
    });

    it('deduplicates by task ID keeping the latest', () => {
      const first = makeSnapshot('task-1', { completedAt: 1, retryCount: 0 });
      const second = makeSnapshot('task-1', { completedAt: 2, retryCount: 1, finalized: true });
      store.appendToLog(first);
      store.appendToLog(second);
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].completedAt).toBe(2);
      expect(store.getExecutionLog()[0].retryCount).toBe(1);
    });

    it('keeps snapshots for different task IDs', () => {
      store.appendToLog(makeSnapshot('task-1'));
      store.appendToLog(makeSnapshot('task-2'));
      expect(store.getExecutionLog()).toHaveLength(2);
    });
  });

  describe('clearLog', () => {
    it('resets the execution log', () => {
      store.appendToLog(makeSnapshot('task-1'));
      expect(store.getExecutionLog()).toHaveLength(1);
      store.clearLog();
      expect(store.getExecutionLog()).toEqual([]);
    });
  });

  describe('load preserves execution log', () => {
    it('rebuilds taskMap but does not clear the execution log', () => {
      store.appendToLog(makeSnapshot('task-1'));
      const task = createTask({ id: 'task-a', title: 'A' });
      store.load([task], ['claude-code']);

      expect(store.get('task-a')).toBeDefined();
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].id).toBe('task-1');
    });
  });

  describe('structural removals leave no terminal record behind', () => {
    it('remove() leaves no completed record behind', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markCompleted('t1');

      store.remove('t1');

      expect(store.isCompleted('t1')).toBe(false);
      expect(store.completedCount).toBe(0);
    });

    it('remove() leaves no failed record behind', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markFailed('t1');

      store.remove('t1');

      expect(store.isFailed('t1')).toBe(false);
      expect(store.isAnyFailed()).toBe(false);
    });

    // `removeTaskFromPlan` detaches the dependency, but a 'blocked' status
    // outlives it — and `isBlocked` reads that status alone, so the dependent
    // would be skipped by the scheduler forever with nothing left to unblock it.
    it('remove() releases a dependent that was blocked on the removed task', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1', status: 'failed' });
      const t2 = createTask({ id: 't2', title: 'Task 2', dependencies: ['t1'], status: 'blocked' });
      store.load([t1, t2], ['claude-code']);

      store.remove('t1');

      expect(store.get('t2')!.status).toBe('pending');
      expect(store.get('t2')!.dependencies).toEqual([]);
    });

    it('merge() leaves neither original id completed or failed', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markCompleted('t1');
      store.markFailed('t2');

      store.merge('t1', 't2');

      expect(store.isCompleted('t1')).toBe(false);
      expect(store.isFailed('t2')).toBe(false);
    });
  });
});

describe('PlanStore.merge', () => {
  it('rewires the dependents onto the survivor, leaving no dependency dangling', () => {
    const store = new PlanStore();
    store.load([
      createTask({ id: 't1', title: 'Task 1' }),
      createTask({ id: 't2', title: 'Task 2', dependencies: ['t1'] }),
      createTask({ id: 't3', title: 'Task 3', dependencies: ['t1', 't2'] }),
    ], ['claude-code']);

    const merged = store.merge('t1', 't2');

    expect(store.get('t3')!.dependencies).toEqual([merged.id]);
    expect(merged.dependencies).toEqual([]);

    const ids = new Set(store.allTasks.map((t) => t.id));
    const dangling = store.allTasks.flatMap((t) => t.dependencies).filter((d) => !ids.has(d));
    expect(dangling).toEqual([]);
  });
});

describe('PlanStore.split', () => {
  // Deriving the chain from the specs' own ids left every later part depending
  // on a placeholder id that matched nothing in the plan.
  it('chains each part onto the previous one, leaving no dependency dangling', () => {
    const store = new PlanStore();
    store.load([
      createTask({ id: 't1', title: 'Task 1' }),
      createTask({ id: 't2', title: 'Task 2', dependencies: ['t1'] }),
      createTask({ id: 't3', title: 'Task 3', dependencies: ['t2'] }),
    ], ['claude-code']);

    const parts = store.split('t2', [{ title: 'Part A' }, { title: 'Part B' }, { title: 'Part C' }]);

    expect(parts[0].dependencies).toEqual(['t1']);
    expect(parts[1].dependencies).toEqual([parts[0].id]);
    expect(parts[2].dependencies).toEqual([parts[1].id]);
    // The task that depended on the original now waits on the tail part.
    expect(store.get('t3')!.dependencies).toEqual([parts[2].id]);

    const ids = new Set(store.allTasks.map((t) => t.id));
    const dangling = store.allTasks.flatMap((t) => t.dependencies).filter((d) => !ids.has(d));
    expect(dangling).toEqual([]);
  });
});

describe('PlanStore.resetForRun', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('flips AI tasks to approved but preserves completed ones by default', () => {
    store.load([
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
      createTask({ id: 'c', title: 'C', status: 'failed' }),
    ], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('completed');
    expect(store.get('b')!.status).toBe('approved');
    expect(store.get('c')!.status).toBe('approved');
  });

  it('re-approves everything for a fresh plan commit with preserveCompleted: false', () => {
    store.load([
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
    ], ['claude-code']);
    // load() records 'a' as completed; a fresh commit starts the run over.
    store.resetForRun({ preserveCompleted: false });

    expect(store.get('a')!.status).toBe('approved');
    expect(store.isCompleted('a')).toBe(false);
    expect(store.completedCount).toBe(0);
    expect(store.get('b')!.status).toBe('approved');
  });

  it('leaves user tasks untouched', () => {
    store.load([
      createTask({ id: 'a', title: 'A', type: 'user', status: 'pending' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
    ], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('pending');
    expect(store.get('b')!.status).toBe('approved');
  });
});

describe('PlanStore completion and failure have one source', () => {
  function expectConsistent(store: PlanStore): void {
    for (const t of store.allTasks) {
      expect(store.isCompleted(t.id), `isCompleted(${t.id})`).toBe(t.status === 'completed');
      expect(store.isFailed(t.id), `isFailed(${t.id})`).toBe(t.status === 'failed');
    }
    expect(store.completedCount).toBe(store.allTasks.filter((t) => t.status === 'completed').length);
    expect(store.failedCount).toBe(store.allTasks.filter((t) => t.status === 'failed').length);
    expect(store.isAnyFailed()).toBe(store.allTasks.some((t) => t.status === 'failed'));
    expect(store.isAllComplete()).toBe(store.allTasks.every((t) => t.status === 'completed'));
  }

  function plan(): Task[] {
    return [
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'failed', dependencies: ['a'] }),
      createTask({ id: 'c', title: 'C', status: 'pending', dependencies: ['b'] }),
      createTask({ id: 'd', title: 'D', type: 'user', status: 'completed' }),
      createTask({ id: 'e', title: 'E', status: 'pending' }),
    ];
  }

  const ops: [string, (store: PlanStore) => void][] = [
    ['load', () => {}],
    ['markCompleted', (s) => s.markCompleted('c')],
    ['markFailed', (s) => s.markFailed('a')],
    ['markInProgress', (s) => { s.markCompleted('e'); s.markInProgress('e'); }],
    ['markPending', (s) => { s.markFailed('e'); s.markPending('e'); }],
    ['markAwaitingUser', (s) => { s.markCompleted('e'); s.markAwaitingUser('e'); }],
    ['retry', (s) => { s.markFailed('b'); s.retry('b'); }],
    ['blockDependents', (s) => { s.markFailed('b'); s.blockDependents('b'); }],
    ['unblockDependents', (s) => { s.markFailed('b'); s.blockDependents('b'); s.unblockDependents('b'); }],
    ['remove', (s) => s.remove('a')],
    ['merge', (s) => { s.markFailed('e'); s.merge('a', 'e'); }],
    ['split', (s) => { s.markCompleted('e'); s.split('e', [{ title: 'E1' }, { title: 'E2' }]); }],
    ['update', (s) => s.update('a', { title: 'A2' })],
    ['resetForRun (preserve)', (s) => { s.markFailed('e'); s.resetForRun(); }],
    ['resetForRun (fresh)', (s) => { s.markFailed('e'); s.resetForRun({ preserveCompleted: false }); }],
  ];

  it.each(ops)('agrees with task.status after %s', (_name, op) => {
    const store = new PlanStore();
    store.load(plan(), ['claude-code']);
    op(store);
    expectConsistent(store);
  });

  // generatePlan loads a new plan and then resets it fresh. A completed id the
  // new plan reuses must not stay "done" for its dependents while its own
  // status says it is ready to run again.
  it('does not leave a reused completed id satisfying dependents after a fresh reset', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'x', title: 'X', status: 'completed' })], ['claude-code']);
    store.load([
      createTask({ id: 'x', title: 'X again', status: 'completed' }),
      createTask({ id: 'y', title: 'Y', dependencies: ['x'] }),
    ], ['claude-code']);

    store.resetForRun({ preserveCompleted: false });

    expect(store.get('x')!.status).toBe('approved');
    expect(store.isCompleted('x')).toBe(false);
    expectConsistent(store);
  });

  it('notifies after resetForRun like the other structural ops', () => {
    const store = new PlanStore();
    store.load(plan(), ['claude-code']);
    let calls = 0;
    store.onMutate = () => { calls++; };
    store.resetForRun();
    expect(calls).toBe(1);
  });
});

describe('PlanStore owns its tasks', () => {
  it('load() changes neither the caller\'s array nor its task objects', () => {
    const tasks = [
      createTask({ id: 'a', title: 'A', status: 'failed', subtasks: [createTask({ id: 'a1', title: 'A1', status: 'failed' })] }),
      createTask({ id: 'b', title: 'B', dependencies: ['a'] }),
    ];
    const before = structuredClone(tasks);
    const store = new PlanStore();

    store.load(tasks, ['claude-code']);
    store.markCompleted('b');
    store.setTaskVerdict('b', { outcome: 'pass', reason: 'r', checks: [], decidedAt: 'now' });
    store.markFailed('a1');
    store.remove('a');

    expect(tasks).toEqual(before);
    expect(store.get('b')!.status).toBe('completed');
  });

  it('keeps its own view when a returned array is changed', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'A' })], ['claude-code']);

    // @ts-expect-error — the getters hand out readonly views
    expect(() => store.planTasks.push(createTask({ id: 'z', title: 'Z' }))).toThrow();
    // @ts-expect-error — the getters hand out readonly views
    expect(() => store.allTasks.pop()).toThrow();
    expect(store.allTasks.map((t) => t.id)).toEqual(['a']);
  });

  it('hands out snapshots that later status changes do not reach', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'A' })], ['claude-code']);
    const snap = store.snapshot();

    store.markCompleted('a');
    expect(snap[0].status).toBe('pending');

    snap[0].status = 'failed';
    expect(store.get('a')!.status).toBe('completed');
  });
});
