import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Session, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

describe('closing a session', () => {
  it('aborts the planner turn it is still waiting on, rather than leaving the model call running', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-destroy-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    let signal: AbortSignal | undefined;
    const spy = vi.spyOn(Session.prototype, 'startPlanning').mockImplementation(async (_goal, _runners, options) => {
      signal = options?.signal;
      return new Promise<LegacyPlanState>(() => {});
    });

    try {
      void pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      await vi.waitFor(() => expect(signal).toBeDefined());

      pool.destroy('s1');

      expect(signal?.aborted).toBe(true);
      expect(pool.cancelPlanning('s1')).toBe(false);
    } finally {
      spy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
