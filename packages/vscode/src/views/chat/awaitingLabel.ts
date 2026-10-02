import type { AwaitingReason, Task } from '@ordewell/core';

const AWAITING_LABELS: Record<AwaitingReason, string> = {
  input: 'Waiting for your input',
  checkpoint: 'Checkpoint',
  conflict: 'Merge conflict',
  'files-changed': 'Changed tracked files',
};

/** What an awaiting_user task waits on (ADR-0018, W1); null when no reason was saved. */
export function awaitingLabel(task: Pick<Task, 'status' | 'awaitingReason'>): string | null {
  return task.status === 'awaiting_user' && task.awaitingReason ? AWAITING_LABELS[task.awaitingReason] : null;
}
