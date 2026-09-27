import { describe, it, expect, vi } from 'vitest';
import { processQueuedBatched, type PlanManagerDeps } from '../PlanManager';

function deps(): PlanManagerDeps {
  return {
    session: { processQueuedMessages: vi.fn().mockResolvedValue(undefined) },
    chatProvider: { showPlan: vi.fn(), showQueueStatus: vi.fn() },
    getCurrentPlan: () => ({ tasks: [] }),
    persistState: vi.fn(),
  } as unknown as PlanManagerDeps;
}

describe('queue status routing', () => {
  it('empties the webview queue once the batch has applied it', async () => {
    const d = deps();

    await processQueuedBatched(d);

    expect(d.chatProvider.showQueueStatus).toHaveBeenCalledWith([]);
  });
});
