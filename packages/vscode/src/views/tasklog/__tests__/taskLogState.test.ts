import { describe, it, expect } from 'vitest';
import { taskLogState } from '../taskLogState';
import type { TaskLogStatus } from '../../../shared/taskLogProtocol';

function status(overrides: Partial<TaskLogStatus> = {}): TaskLogStatus {
  return {
    taskId: 't1', order: 1, title: 'Task', runner: 'claude-code',
    planStatus: 'in_progress', working: false, queued: [], attempts: [1], attempt: 1, continuable: false,
    ...overrides,
  };
}

describe('what a task log header says (ADR-0018, V1)', () => {
  it('a running turn reads as working, whatever the saved reason is', () => {
    expect(taskLogState(status({ working: true })).label).toBe('Working');
    expect(taskLogState(status({ working: true, awaitingReason: 'input' })).label).toBe('Working');
  });

  it.each([
    ['input', 'waiting', 'Waiting for your input'],
    ['checkpoint', 'checkpoint', 'Waiting at a checkpoint'],
    ['conflict', 'waiting', 'Waiting on a merge conflict'],
  ] as const)('a task waiting on %s is shown as %s', (awaitingReason, kind, label) => {
    expect(taskLogState(status({ awaitingReason }))).toMatchObject({ kind, label });
  });

  it('reads the task status before the last turn end', () => {
    expect(taskLogState(status({ planStatus: 'completed', lastTurnEnd: 'failed' }))).toMatchObject({ kind: 'done', label: 'Done' });
    expect(taskLogState(status({ planStatus: 'failed' }))).toMatchObject({ kind: 'failed', label: 'Failed' });
  });

  it('falls back to how the last turn ended, then idle', () => {
    expect(taskLogState(status({ lastTurnEnd: 'failed' }))).toMatchObject({ kind: 'failed', label: 'Turn failed' });
    expect(taskLogState(status({ lastTurnEnd: 'interrupted' }))).toMatchObject({ kind: 'idle', label: 'Interrupted' });
    expect(taskLogState(status({ planStatus: 'draft' }))).toMatchObject({ kind: 'idle', label: 'Idle' });
  });
});
