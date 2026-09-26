import { describe, it, expect } from 'vitest';
import { describeMergeResult } from '../mergeResultNotice';
import type { IsolationLandedTask } from '../../interfaces/IWorktreeIsolation';

describe('describeMergeResult — repaired tasks (ADR-0015)', () => {
  const repaired: IsolationLandedTask[] = [
    { taskId: 'r', order: 1, title: 'Task r', repairedFiles: ['a.ts', 'b.ts'] },
  ];

  it('names a repaired task and its files alongside a clean merge', () => {
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', false, repaired);
    expect(message).toBe(
      'Merged ordewell/r1/integration into your checked-out branch. Task r (a.ts, b.ts) landed through a conflict repair.',
    );
  });

  it('names more than one repaired task', () => {
    const both = [...repaired, { taskId: 's', order: 2, title: 'Task s', repairedFiles: ['c.ts'] }];
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', true, both);
    expect(message).toBe(
      'Merged ordewell/r1/integration into the checked-out branch of every repository. Task r (a.ts, b.ts) and Task s (c.ts) landed through conflict repairs.',
    );
  });

  it('says nothing extra when no landed task was repaired', () => {
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', false, []);
    expect(message).toBe('Merged ordewell/r1/integration into your checked-out branch.');
  });

  it('defaults to no repaired tasks when the caller has none to report', () => {
    const { message } = describeMergeResult({ outcome: 'merged' }, 'ordewell/r1/integration', false);
    expect(message).toBe('Merged ordewell/r1/integration into your checked-out branch.');
  });
});
