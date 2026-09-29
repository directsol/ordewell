import type { TaskLogStatus } from '../../shared/taskLogProtocol';

export type TaskLogStateKind = 'working' | 'waiting' | 'checkpoint' | 'done' | 'failed' | 'idle';

export interface TaskLogState {
  kind: TaskLogStateKind;
  label: string;
}

/**
 * What a task log's header says the task is doing (ADR-0018, V1): the live
 * turn first, then the saved reason it waits, then how it settled. "Waiting
 * for approval" joins here once slice 8 records pending approvals — approvals
 * arrive mid-turn, so they will not replace the working state.
 */
export function taskLogState(
  status: Pick<TaskLogStatus, 'working' | 'awaitingReason' | 'planStatus' | 'lastTurnEnd'>,
): TaskLogState {
  if (status.working) return { kind: 'working', label: 'Working' };
  switch (status.awaitingReason) {
    case 'checkpoint': return { kind: 'checkpoint', label: 'Waiting at a checkpoint' };
    case 'input': return { kind: 'waiting', label: 'Waiting for your input' };
    case 'conflict': return { kind: 'waiting', label: 'Waiting on a merge conflict' };
  }
  if (status.planStatus === 'completed') return { kind: 'done', label: 'Done' };
  if (status.planStatus === 'failed') return { kind: 'failed', label: 'Failed' };
  if (status.lastTurnEnd === 'failed') return { kind: 'failed', label: 'Turn failed' };
  if (status.lastTurnEnd === 'interrupted') return { kind: 'idle', label: 'Interrupted' };
  return { kind: 'idle', label: 'Idle' };
}
