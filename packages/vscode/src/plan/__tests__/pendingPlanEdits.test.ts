import { describe, it, expect, vi } from 'vitest';
import { processQueuedBatched, type PlanManagerDeps } from '../PlanManager';

function deps(): PlanManagerDeps {
  return {
    session: { processQueuedMessages: vi.fn().mockResolvedValue(undefined) },
    chatProvider: { showPlan: vi.fn(), showPendingPlanEdits: vi.fn() },
    getCurrentPlan: () => ({ tasks: [] }),
    persistState: vi.fn(),
  } as unknown as PlanManagerDeps;
}

describe('pending plan edits routing', () => {
  it('empties the webview\'s pending edits once the batch has applied them', async () => {
    const d = deps();

    await processQueuedBatched(d);

    expect(d.chatProvider.showPendingPlanEdits).toHaveBeenCalledWith([]);
  });
});
