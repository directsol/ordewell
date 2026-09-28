import type { Task } from '../models/Task';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';

/** What the scheduler may read to decide what runs: read-only plan state, the holds, and the open isolated run. */
export interface ReadinessInput {
  store: Pick<PlanStore, 'allTasks' | 'isCompleted' | 'isFailed'>;
  /** Task ids pulled out of auto-scheduling (cancelled, or a spawn that failed). */
  onHold: ReadonlySet<string>;
  /** The open isolated run's records; `openRecord` answers undefined for a shared-root run. */
  runs: Pick<IsolationRunController, 'openRecord'>;
  /** Attempts already holding a slot. */
  active: number;
  maxParallel: number;
}

/** One AI task the gates held back, with why, for the scheduler's log. */
export interface ReadyTaskExclusion {
  task: Readonly<Task>;
  reasons: string[];
}

export interface Readiness {
  /** The tasks to start, lowest order first, capped at the free slots. */
  ready: Task[];
  /** How many tasks passed every gate, before the slot cap. */
  candidateCount: number;
  /** AI tasks with a prompt the gates held back, with why. Empty when the slots are full. */
  excluded: ReadyTaskExclusion[];
}

/**
 * The scheduler's readiness rule as one pure function over the plan and the
 * holds: an AI task with a prompt is ready while it is pending or approved,
 * off hold, unblocked, and every dependency's work is on the integration
 * branch. `active` is the slots already taken, so no more than `maxParallel`
 * run at once.
 */
export function selectReadyTasks(input: ReadinessInput): Readiness {
  const { store, onHold, runs, active, maxParallel } = input;
  if (active >= maxParallel) return { ready: [], candidateCount: 0, excluded: [] };
  const availableSlots = maxParallel - active;

  const candidates = store.allTasks.filter((t) => {
    if (t.status !== 'pending' && t.status !== 'approved') return false;
    if (t.type === 'user') return false;
    if (!t.prompt) return false;
    if (onHold.has(t.id)) return false;
    if (isBlocked(t, store)) return false;
    if (!t.dependencies.every((depId) => dependencyMet(depId, store, runs))) return false;
    return true;
  });

  const excluded = store.allTasks
    .filter((t) => t.type === 'ai' && t.prompt && !candidates.includes(t))
    .map((task) => ({ task, reasons: exclusionReasons(task, store, onHold, runs) }));

  return {
    ready: candidates.sort((a, b) => a.order - b.order).slice(0, availableSlots),
    candidateCount: candidates.length,
    excluded,
  };
}

/** A task is blocked when it was parked as blocked, or a dependency of it failed. */
export function isBlocked(task: Readonly<Task>, store: Pick<PlanStore, 'isFailed'>): boolean {
  if (task.status === 'blocked') return true;
  if (task.dependencies.length > 0) return task.dependencies.some((depId) => store.isFailed(depId));
  return false;
}

/**
 * In an isolated run a dependency is met once its work is on the integration
 * branch, not merely once it passed: the dependent's worktree is cut from that
 * branch, so starting earlier would hand it a tree without the work it depends
 * on.
 */
export function dependencyMet(
  depId: string,
  store: Pick<PlanStore, 'isCompleted'>,
  runs: Pick<IsolationRunController, 'openRecord'>,
): boolean {
  if (!store.isCompleted(depId)) return false;
  const record = runs.openRecord(depId);
  return !record || record.status === 'merged';
}

function exclusionReasons(
  task: Readonly<Task>,
  store: Pick<PlanStore, 'isCompleted' | 'isFailed'>,
  onHold: ReadonlySet<string>,
  runs: Pick<IsolationRunController, 'openRecord'>,
): string[] {
  const reasons: string[] = [];
  if (task.status !== 'pending' && task.status !== 'approved') reasons.push(`status=${task.status}`);
  if (onHold.has(task.id)) reasons.push('on-hold');
  if (isBlocked(task, store)) reasons.push('blocked');
  if (!task.dependencies.every((depId) => dependencyMet(depId, store, runs))) reasons.push('deps');
  return reasons;
}
