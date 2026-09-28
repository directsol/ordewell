import { describe, it, expect, vi } from 'vitest';
import { IsolationRunController, type IsolationRunListener } from '../IsolationRunController';
import { createTask, type Task } from '../../models/Task';
import type { IsolationOutcome } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';

function setup(isolation = new FakeWorktreeIsolation()) {
  const listener: IsolationRunListener = {
    changed: vi.fn(),
    blocked: vi.fn(),
    handoff: vi.fn(),
    notice: vi.fn(),
    releasing: vi.fn(),
  };
  const notifications = fakeNotification();
  const runs = new IsolationRunController({ isolation, config: fakeConfig(), notifications, workspaceRoot: () => '/repo', listener });
  return { runs, isolation, listener, notifications };
}

const task = (id: string, order: number): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}` });

const ops = (isolation: FakeWorktreeIsolation) => isolation.calls.map((c) => c.op);

describe('IsolationRunController', () => {
  describe('open', () => {
    it('mints an isolated run once and reports it as a change', async () => {
      const { runs, isolation, listener } = setup();

      expect(await runs.open(async () => undefined)).toBe(true);
      expect(await runs.open(async () => undefined)).toBe(true);

      expect(runs.isOpen).toBe(true);
      expect(runs.isolating).toBe(true);
      expect(runs.current?.id).toBe('run1');
      expect(ops(isolation).filter((op) => op === 'startRun')).toHaveLength(1);
      expect(listener.changed).toHaveBeenCalled();
      expect(runs.planIsolation).toEqual({ run: runs.current, resolvers: {} });
    });

    it('decides once for starts that race each other', async () => {
      const { runs, isolation } = setup();

      await Promise.all([runs.open(async () => undefined), runs.open(async () => undefined)]);

      expect(ops(isolation).filter((op) => op === 'isActive')).toHaveLength(1);
    });

    it('opens a shared run with a notice where the workspace cannot isolate', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'not-git' };
      const { runs, listener, notifications } = setup(isolation);

      expect(await runs.open(async () => undefined)).toBe(true);

      expect(runs.isOpen).toBe(true);
      expect(runs.isolating).toBe(false);
      expect(runs.current).toBeNull();
      expect(notifications.info).toHaveBeenCalledWith(expect.stringContaining('Not a git repository'));
      expect(listener.notice).toHaveBeenCalledWith('info', expect.stringContaining('Not a git repository'));
    });

    it('continues an adopted run that holds work instead of minting a new one', async () => {
      const { runs: first } = setup();
      await first.open(async () => undefined);
      await first.attemptCwd(task('t1', 1), { repair: false });
      await first.release('t1', { keep: true });
      const saved = first.planIsolation;

      const { runs, isolation } = setup();
      await runs.adopt(saved);
      await runs.open(async () => undefined);

      expect(runs.current?.id).toBe('run1');
      expect(ops(isolation)).toContain('pruneOrphans');
      expect(ops(isolation)).not.toContain('startRun');
    });
  });

  describe('attemptCwd', () => {
    it('gives an attempt in an isolated run the worktree prepared for it', async () => {
      const { runs } = setup();
      await runs.open(async () => undefined);

      expect(await runs.attemptCwd(task('t1', 1), { repair: false })).toEqual({ cwd: '/fake-worktrees/run1/1-t1', worktree: true });
      expect(runs.taskIsolation('t1')).toMatchObject({ state: 'active' });
    });

    it('gives an attempt in a shared run the workspace root', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'disabled' };
      const { runs } = setup(isolation);
      await runs.open(async () => undefined);

      expect(await runs.attemptCwd(task('t1', 1), { repair: false })).toEqual({ cwd: '/repo', worktree: false });
      expect(isolation.taskIdsFor('prepare')).toEqual([]);
    });

    it('reopens the kept worktree for a conflict repair', async () => {
      const { runs, isolation } = setup();
      await runs.open(async () => undefined);
      const t1 = task('t1', 1);
      await runs.attemptCwd(t1, { repair: false });
      runs.current!.tasks.t1.status = 'conflict';

      expect(await runs.attemptCwd(t1, { repair: true })).toEqual({ cwd: '/fake-worktrees/run1/1-t1', worktree: true });
      expect(isolation.taskIdsFor('reopen')).toEqual(['t1']);
    });

    it('reports copied paths once per run, not once per task', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.copied = ['.env'];
      const { runs, listener } = setup(isolation);
      await runs.open(async () => undefined);

      await runs.attemptCwd(task('t1', 1), { repair: false });
      await runs.attemptCwd(task('t2', 2), { repair: false });

      expect(vi.mocked(listener.notice).mock.calls.filter(([, m]) => m.includes('.env'))).toHaveLength(1);
    });
  });

  describe('blocked run', () => {
    it('parks the start on a dirty tree and hands it back once stashed', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty', repos: ['api'] };
      const { runs, listener } = setup(isolation);
      const resume = vi.fn(async () => undefined);

      expect(await runs.open(resume)).toBe(false);
      expect(runs.blocked).toBe(true);
      expect(runs.isOpen).toBe(false);
      expect(listener.blocked).toHaveBeenCalledWith(['api']);

      expect(await runs.continueBlocked('stash')).toBe(resume);
      expect(runs.blocked).toBe(false);
      expect(ops(isolation)).toContain('stash');
      expect(listener.notice).toHaveBeenCalledWith('info', expect.stringContaining('Stashed your uncommitted changes in api'));
      expect(resume).not.toHaveBeenCalled();

      expect(await runs.open(resume)).toBe(true);
      expect(runs.isolating).toBe(true);
    });

    it('opens a shared run when the user goes on without isolation', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const { runs } = setup(isolation);
      const resume = vi.fn(async () => undefined);
      await runs.open(resume);

      expect(await runs.continueBlocked('shared')).toBe(resume);

      expect(runs.isOpen).toBe(true);
      expect(runs.isolating).toBe(false);
      expect(ops(isolation)).not.toContain('stash');
    });

    it('has nothing to continue without a parked start', async () => {
      const { runs } = setup();
      expect(await runs.continueBlocked('stash')).toBeNull();
    });

    it('drops the parked start on an interrupt', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const { runs } = setup(isolation);
      await runs.open(async () => undefined);

      runs.interrupt();

      expect(runs.blocked).toBe(false);
    });
  });

  describe('close', () => {
    it('hands an isolated run over and keeps its record for review', async () => {
      const { runs, listener } = setup();
      await runs.open(async () => undefined);
      const t1 = task('t1', 1);
      await runs.attemptCwd(t1, { repair: false });
      runs.current!.tasks.t1.status = 'merged';

      await runs.close();

      expect(runs.isOpen).toBe(false);
      expect(listener.handoff).toHaveBeenCalledWith(expect.objectContaining({ landed: [expect.objectContaining({ taskId: 't1' })] }));
      expect(runs.current).not.toBeNull();
    });

    it('closes a shared run without a handoff', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'disabled' };
      const { runs, listener } = setup(isolation);
      await runs.open(async () => undefined);

      await runs.close();

      expect(runs.isOpen).toBe(false);
      expect(listener.handoff).not.toHaveBeenCalled();
    });

    it('keeps a run the scheduler still drives open through an interrupt that asks it to', async () => {
      const { runs } = setup();
      await runs.open(async () => undefined);

      runs.interrupt({ keepOpen: true });
      expect(runs.isOpen).toBe(true);

      runs.interrupt();
      expect(runs.isOpen).toBe(false);
    });

    it('forgets the run once everything merged into the checked-out branch', async () => {
      const { runs, listener } = setup();
      await runs.open(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });

      expect(await runs.merge()).toEqual({ outcome: 'merged' });

      expect(listener.releasing).toHaveBeenCalledWith(['t1']);
      expect(runs.current).toBeNull();
      expect(runs.planIsolation).toBeNull();
    });
  });

  describe('release', () => {
    it('removes a worktree the task no longer needs, after whatever runs in it', async () => {
      const { runs, isolation, listener } = setup();
      await runs.open(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });

      await runs.release('t1', { keep: false });

      expect(listener.releasing).toHaveBeenCalledWith(['t1']);
      expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
      expect(runs.taskIsolation('t1')).toEqual({ state: 'none' });
      expect(listener.changed).toHaveBeenCalled();
    });

    it('keeps a worktree for inspection without closing what runs in it', async () => {
      const { runs, listener } = setup();
      await runs.open(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });

      await runs.release('t1', { keep: true });

      expect(listener.releasing).not.toHaveBeenCalled();
      expect(runs.taskIsolation('t1')).toMatchObject({ state: 'kept' });
    });

    it('waits for a merge in flight before touching the worktree', async () => {
      const { runs, isolation } = setup();
      await runs.open(async () => undefined);
      await runs.attemptCwd(task('t1', 1), { repair: false });
      let settle!: (outcome: IsolationOutcome) => void;
      const integration = new Promise<IsolationOutcome>((resolve) => { settle = resolve; });

      const released = runs.release('t1', { keep: false }, integration);
      await Promise.resolve();
      expect(isolation.taskIdsFor('release')).toEqual([]);

      settle('merged');
      await released;
      expect(isolation.taskIdsFor('release')).toEqual(['t1']);
    });

    it('does nothing for a task the run has no record of', async () => {
      const { runs, isolation, listener } = setup();
      await runs.open(async () => undefined);

      await runs.release('ghost', { keep: false });

      expect(isolation.taskIdsFor('release')).toEqual([]);
      expect(listener.releasing).not.toHaveBeenCalled();
    });
  });

  it('forgets a resolver link as it hands it back', async () => {
    const { runs } = setup();
    await runs.open(async () => undefined);

    runs.linkResolver('r1', 't1');
    expect(runs.planIsolation?.resolvers).toEqual({ r1: 't1' });

    expect(runs.takeResolver('r1')).toBe('t1');
    expect(runs.takeResolver('r1')).toBeUndefined();
  });
});
