import * as path from 'path';
import { Task, TaskSnapshot, Verdict, QueuedMessage, RunnerId, flattenTasksWithParents, taskOrderLabel } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import { ITerminalRunner, ITerminalSession } from '../interfaces/ITerminalRunner';
import { composeAugmentedPrompt, summarizeOutput } from './promptAugment';
import { VerdictEngine } from './VerdictEngine';
import { BufferedTaskOutputSource } from './BufferedTaskOutputSource';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type {
  IsolationHandoff,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationView,
  IWorktreeIsolation,
  PlanIsolation,
  RepairEvidence,
  TaskIsolation,
} from '../interfaces/IWorktreeIsolation';
import { createWorktreeIsolation } from './GitWorktreeIsolation';
import { capConflictFiles, integrationBranchNameOf, SELF_REPO } from './isolationRecord';
import { IsolationRunController } from './IsolationRunController';
import type { IsolatedExecution } from './plannerModes';
import { buildConflictRepairPrompt } from './PlanPrompts';
import { watchBlockingPrompts } from './blockingPrompts';
import { resolveWorkspaceEnv, type WorkspaceEnv } from './workspaceEnv';

/**
 * The one notification channel out of the orchestrator. Everything that used
 * to travel over separate callbacks (onRefresh, onQueueReady) is an observer
 * event; the Session subscribes once and turns these into SessionMessages.
 */
export interface OrchestratorObserver {
  /** Any task-shaped state changed (store mutation, checkpoint, retry, …). */
  onTaskChanged?(): void;
  onTick?(): void;
  onExecutionComplete?(): void;
  /** Queued user messages are ready to be processed by the planner. */
  onQueueReady?(): void;
  onReviewNeeded?(data: { tasks: Task[]; planRunners: RunnerId[] }): void;
  onReviewApproved?(data: { tasks: Task[] }): void;
  onCheckpoint?(data: { taskId: string; taskTitle: string; summary: string }): void;
  /** The isolation run record changed and should be persisted with the plan. */
  onIsolationChanged?(): void;
  /** A run did not start: the tree is dirty, and the user picks stash or no isolation. `repos` names the dirty repos of a group. */
  onIsolationBlocked?(data: { reason: 'dirty'; repos: string[] }): void;
  /** An isolated run settled; emitted before `onExecutionComplete`, which surfaces treat as terminal. */
  onIsolationHandoff?(handoff: IsolationHandoff): void;
  /**
   * What a run says about how it isolates — the fallback to the workspace root,
   * shared paths, copies, a stash. Beside the notification channel, which a
   * daemon may leave unwired, so a surface without toasts can still show it.
   */
  onIsolationNotice?(data: { level: 'info' | 'warn' | 'error'; message: string }): void;
}

/**
 * What a runner says when its account, not the task, ran out. A marker-less
 * stop that names a limit is retryable once the limit resets, so it pauses the
 * task instead of failing it. Deliberately narrow: a false positive would leave
 * a genuinely broken task waiting on the user forever, and the words below are
 * the ones the runners print for this and nothing else.
 */
const USAGE_LIMIT_RE = /\b(?:usage|session|weekly|daily|monthly) limit\b|\brate limit (?:exceeded|reached)\b|\brate[- ]limited\b|\blimit (?:will )?reset\b|\bquota (?:exceeded|reached)\b|\btoo many requests\b/i;

/** How much of a stopped runner's tail is read for the limit signature: the error is the last thing it prints. */
const USAGE_LIMIT_TAIL = 4096;

/**
 * One run of one task, from the moment the scheduler claims it until its
 * verdict, cancel, stop or plan load. Everything that has to die with the run
 * lives on this record, so {@link TaskOrchestrator.endAttempt} releases all of
 * it at once and nothing can be left behind for one exit path to forget.
 */
interface TaskAttempt {
  readonly taskId: string;
  /** 1-based count of spawns this task has had since the plan was loaded. */
  readonly attempt: number;
  /**
   * `starting` while the async spawn is in flight; `session` is null until
   * `running`. `integrating` once a passed verdict is merging the attempt's
   * worktree — still live, so the task neither completes nor frees its
   * dependents until the merge says so.
   */
  phase: AttemptPhase;
  session: ITerminalSession | null;
  readonly runner: string;
  /** Null until {@link IsolationRunController.attemptCwd} settles. */
  cwd: string | null;
  /** Whether `cwd` is a worktree prepared for this attempt rather than the workspace root. */
  worktree: boolean;
  /** The merge in flight, so a cancel waits for it before tearing the worktree down. */
  integration: Promise<IsolationOutcome> | null;
  /** Set when this attempt is a conflict repair (ADR-0015) of work that already passed. */
  readonly repair: RepairAttempt | null;
  readonly startedAt: string;
}

type AttemptPhase = 'starting' | 'running' | 'integrating';

/** Which repair of a task an attempt is, of the most `conflictRepairAttempts` allows. */
interface RepairAttempt {
  n: number;
  limit: number;
}

/** Read-only view of a task's live attempt. */
export interface TaskAttemptSnapshot {
  taskId: string;
  attempt: number;
  phase: AttemptPhase;
  sessionId: string | null;
  runner: string;
  cwd: string | null;
  startedAt: string;
}

type AttemptEnd = 'verdict' | 'cancel' | 'release' | 'complete' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * The pure scheduler. Owns execution state (`running`, `planStatus`,
 * `reviewApproved`, the live task attempts, `messageQueue`) and the verifier.
 * All task-shaped state — the plan tree, the flat index, the completed set
 * — lives in {@link PlanStore}, injected at construction. The orchestrator
 * calls `store.markCompleted(id)` / `store.markFailed(id)` instead of mutating
 * task state directly. A task completes only after the runner emits its
 * per-task completion marker; process exit without that evidence is a visible
 * failure and does not unblock dependent work.
 */
export class TaskOrchestrator {
  private store: PlanStore;
  private attempts = new Map<string, TaskAttempt>();
  private verifier = new VerdictEngine();
  private running = false;
  private planStatus: 'approved' | 'running' | 'completed' = 'approved';
  private messageQueue: QueuedMessage[] = [];
  private queueSeq = 0;
  private reviewApproved = false;
  /*
   * Retry counts, spawn counts and holds describe a task across attempts, so
   * they deliberately live outside the attempt record: ending an attempt must
   * not forget that the user held the task or how often it has run.
   */
  private retryCounts = new Map<string, number>();
  private spawnCounts = new Map<string, number>();
  /**
   * The terminal a verdict left open, by task. It stays so the user can read
   * the agent's output or keep talking to it — but only while its worktree
   * does: once that is removed the agent sits in a deleted directory, and a
   * newer attempt in the same worktree would share it with a second agent.
   * Without this, every task of every run left one agent process running
   * until the daemon stopped.
   */
  private lingering = new Map<string, string>();
  /**
   * A full-plan run a failure paused. Retrying the failed task is the explicit
   * resume the pause waits for — without this a retry only reset the task to
   * pending and nothing ran until the user also re-ran the whole plan.
   */
  private haltedByFailure = false;
  /** The workspace's own variables for a task's cwd (ADR-0016); swapped out in tests. */
  private workspaceEnv: (cwd: string) => Promise<WorkspaceEnv> = (cwd) => resolveWorkspaceEnv(cwd);
  /** What the workspace env has already warned about, so a run says it once, not per task. */
  private envWarnings = new Set<string>();
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled or failed to spawn).
   * They stay 'pending' — "not executed" — but the scheduler skips them until
   * the user retries or force-starts, which would otherwise loop forever on a
   * task whose spawn always throws.
   */
  private onHold = new Set<string>();

  private isolation: IWorktreeIsolation;
  /** The plan's isolation run (ADR-0013). Outlives one run: a resumed plan continues it. */
  /** The plan's isolation run and the open run's lifecycle (ADR-0013); see {@link IsolationRunController}. */
  private runs: IsolationRunController;

  private registry: RunnerRegistry | null = null;
  private workspaceRootFn: () => string = () => process.cwd();
  private observers: OrchestratorObserver[] = [];
  private tddEnabled: () => boolean = () => false;

  constructor(
    private config: IConfig,
    private notifications: INotification,
    private terminalRunner: ITerminalRunner,
    store?: PlanStore,
    private output: TaskOutputSource = new BufferedTaskOutputSource(),
    isolation?: IWorktreeIsolation,
  ) {
    this.store = store ?? new PlanStore();
    this.isolation = isolation ?? createWorktreeIsolation({ config });
    this.runs = new IsolationRunController({
      isolation: this.isolation,
      config,
      notifications,
      workspaceRoot: () => this.workspaceRootFn(),
      listener: {
        changed: () => this.emit('onIsolationChanged'),
        blocked: (repos) => this.emit('onIsolationBlocked', { reason: 'dirty', repos }),
        handoff: (handoff) => this.emit('onIsolationHandoff', handoff),
        notice: (level, message) => this.emit('onIsolationNotice', { level, message }),
        releasing: (taskIds) => { for (const taskId of taskIds) this.closeLingering(taskId); },
      },
    });
    this.store.onMutate = () => this.emit('onTaskChanged');
    this.verifier.onVerdict((taskId, verdict) => this.onVerdict(taskId, verdict));
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.store.get(taskId);
      if (!task) return;
      this.store.markAwaitingUser(taskId);
      this.emit('onCheckpoint', { taskId, taskTitle: task.title, summary });
    });
    // idleSince is advisory UI state, not a store mutation — broadcast it
    // through the same onTaskChanged seam without touching PlanStore.
    this.verifier.onIdleChange(() => this.emit('onTaskChanged'));
  }

  /** Advisory silence timestamp for a task's live runner, or null if not idle. */
  getIdleSince(taskId: string): string | null {
    return this.verifier.getIdleSince(taskId);
  }

  /** Recent clean output of a task's latest attempt, running or ended; null if it never ran. */
  getLiveOutput(taskId: string, opts: LiveTailOptions): LiveTail | null {
    return this.output.liveTail(taskId, opts);
  }

  get storeInstance(): PlanStore { return this.store; }

  setWorkspaceRoot(fn: () => string): void {
    this.workspaceRootFn = fn;
  }

  setWorkspaceEnvResolver(resolve: (cwd: string) => Promise<WorkspaceEnv>): void {
    this.workspaceEnv = resolve;
  }

  /**
   * The variables a task's agent gets from its workspace. What cannot be
   * applied is said once — silently starting without them is how agents ran
   * under the wrong account when an edited `.envrc` was left unallowed.
   */
  private async envForTask(cwd: string): Promise<Record<string, string>> {
    const resolved = await this.workspaceEnv(cwd);
    const warn = (key: string, message: string) => {
      if (this.envWarnings.has(key)) return;
      this.envWarnings.add(key);
      this.notifications.warn(message);
    };
    if (resolved.blockedEnvrc) {
      warn(`blocked:${resolved.blockedEnvrc}`, `direnv has blocked ${resolved.blockedEnvrc}, so tasks start without its variables. Run \`direnv allow\` in ${path.dirname(resolved.blockedEnvrc)} to use them.`);
    }
    if (resolved.trackedEnvFile) {
      warn(`tracked:${resolved.trackedEnvFile}`, `Ignored ${resolved.trackedEnvFile}: git tracks it, and a committed file must not choose the environment agents run in. Untrack it to use it.`);
    }
    if (resolved.refused.length > 0) {
      warn(`refused:${resolved.refused.join(',')}`, `Ignored ${resolved.refused.join(', ')} from the workspace environment: Ordewell never passes these to agents.`);
    }
    return resolved.env;
  }

  setRegistry(registry: RunnerRegistry): void {
    this.registry = registry;
  }

  /**
   * A getter rather than a value where the caller has one: every task gets its
   * prompt composed at spawn time, but only a full-plan run passes through a
   * point where a snapshot could be refreshed — so "Run task", force-start and
   * retry would compose against whatever the last run happened to set.
   */
  setTddEnabled(enabled: boolean | (() => boolean)): void {
    this.tddEnabled = typeof enabled === 'function' ? enabled : () => enabled;
  }

  /*
   * A checkpoint only exists while its attempt runs. Without a live attempt the
   * task is awaiting the user for another reason — a merge conflict — and
   * putting it back to in_progress would strand it with no runner behind it.
   */
  approveCheckpoint(taskId: string): void {
    if (!this.attempts.has(taskId)) return;
    this.verifier.approveCheckpoint(taskId);
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    if (!this.attempts.has(taskId)) return;
    this.verifier.rejectCheckpoint(taskId, reason ?? 'Checkpoint rejected by user');
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  subscribe(observer: OrchestratorObserver): () => void {
    this.observers.push(observer);
    return () => {
      this.observers = this.observers.filter(o => o !== observer);
    };
  }

  /**
   * Isolated per observer: one that throws must not take down the scheduler
   * or stop the remaining observers from hearing the event.
   */
  private emit(event: keyof OrchestratorObserver, ...args: unknown[]): void {
    for (const o of this.observers) {
      const fn = o[event] as (...args: unknown[]) => void;
      if (!fn) continue;
      try {
        fn(...args);
      } catch (err) {
        console.error(`[TaskOrchestrator] observer threw from ${event}:`, err);
      }
    }
  }

  get isRunning(): boolean {
    return this.running || this.attempts.size > 0;
  }
  /**
   * A runner is executing *right now*. Narrower than {@link isRunning}, which
   * also covers the armed-but-idle scheduler `tick()` deliberately leaves
   * behind when a plan is paused on a user task, a checkpoint or a hold —
   * nothing is executing then, so nothing is reading the plan mid-mutation.
   */
  get hasLiveWork(): boolean {
    return this.attempts.size > 0;
  }
  get isReviewApproved(): boolean { return this.reviewApproved; }
  get status(): 'approved' | 'running' | 'completed' { return this.planStatus; }
  get activeTaskIds(): string[] { return [...this.activeSessionMap.keys()]; }
  /** Task id → session id of every attempt whose runner is up; a spawn in flight has no session yet. */
  get activeSessionMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, attempt] of this.attempts) {
      if (attempt.session) map.set(taskId, attempt.session.id);
    }
    return map;
  }

  getAttempt(taskId: string): TaskAttemptSnapshot | undefined {
    const attempt = this.attempts.get(taskId);
    if (!attempt) return undefined;
    const { taskId: id, attempt: n, phase, session, runner, cwd, startedAt } = attempt;
    return { taskId: id, attempt: n, phase, sessionId: session?.id ?? null, runner, cwd, startedAt };
  }

  /** Where a task's isolated work stands; null when the plan has no isolation run to speak of. */
  getTaskIsolation(taskId: string): TaskIsolation | null {
    return this.runs.taskIsolation(taskId);
  }

  /**
   * The plan's isolation as a surface shows it, for one with no stream to have
   * told it — a reconnected webview, a session just loaded. Null without a run.
   */
  isolationView(): IsolationView | null {
    return this.runs.view();
  }

  getAttemptSession(taskId: string): ITerminalSession | undefined {
    return this.attempts.get(taskId)?.session ?? undefined;
  }
  get queuedCount(): number { return this.messageQueue.length; }

  /** A run is waiting on the user to stash or to go on without isolation. */
  get awaitingIsolationChoice(): boolean { return this.runs.blocked; }

  /**
   * Take over a plan's persisted isolation, or none for a plan that has not
   * isolated yet, pruning what a crashed process left behind. Silent on the
   * observer: adopting is not a change to persist.
   */
  async adoptIsolation(state: PlanIsolation | null): Promise<void> {
    await this.runs.adopt(state);
  }

  async reviewRunDiff(): Promise<string> {
    return this.runs.reviewDiff();
  }

  /** "Merge all"; a run that merged everything is cleared up and forgotten. */
  async mergeRun(): Promise<IsolationMergeResult> {
    return this.runs.merge();
  }

  /** Worktrees and task branches go; the integration branch and the record stay for review and merge. */
  async cleanupRun(): Promise<void> {
    await this.runs.cleanup();
  }

  /** The run and everything it made go, and the plan forgets it; the next run starts afresh. */
  async discardRun(): Promise<void> {
    await this.runs.discard();
  }

  private watchBlockingPrompts(task: Task, attempt: TaskAttempt, session: ITerminalSession): void {
    const manifest = this.registry?.get(attempt.runner)?.manifest;
    watchBlockingPrompts(session, manifest?.runner.blockingPrompts ?? [], (prompt) => {
      if (this.attempts.get(task.id) !== attempt) return;
      this.notifications.warn(`Task "${task.title}" is waiting for you: ${manifest?.displayName ?? attempt.runner} is asking ${prompt.asks}. Answer it in the task's terminal.`);
    });
  }

  private closeLingering(taskId: string): void {
    const sessionId = this.lingering.get(taskId);
    if (sessionId === undefined) return;
    this.lingering.delete(taskId);
    this.terminalRunner.stop(sessionId);
  }

  /** What the plan persists of isolated execution; null when no run ever isolated. */
  get isolationRecord(): PlanIsolation | null {
    return this.runs.planIsolation;
  }

  queueMessage(text: string): void {
    this.messageQueue.push({
      // A sequence, not just the clock: two sends inside one millisecond must
      // stay distinguishable, since a surface removes one by id.
      id: `q-${Date.now()}-${++this.queueSeq}`,
      text,
      timestamp: new Date().toISOString(),
    });
    this.emit('onTaskChanged');
  }

  getQueuedMessages(): QueuedMessage[] {
    return [...this.messageQueue];
  }

  /** Take one unsent message back out of the queue; false when it was never there (or already drained). */
  removeQueuedMessage(id: string): boolean {
    const index = this.messageQueue.findIndex((m) => m.id === id);
    if (index < 0) return false;
    this.messageQueue.splice(index, 1);
    this.emit('onTaskChanged');
    return true;
  }

  setQueuedMessages(messages: QueuedMessage[]): void {
    this.messageQueue = [...messages];
  }

  clearQueuedMessages(): void {
    this.messageQueue = [];
  }

  processNextQueuedMessage(): QueuedMessage | null {
    if (this.messageQueue.length === 0) return null;
    return this.messageQueue.shift() ?? null;
  }

  loadPlan(tasks: readonly Task[], planRunners: RunnerId[] = ['claude-code']): void {
    this.store.load(tasks, planRunners);
    const repairs = this.endAllAttempts('load').filter((a) => a.repair && a.worktree);
    for (const a of repairs) void this.runs.release(a.taskId, { keep: true }, a.integration);
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    this.runs.interrupt({ keepOpen: this.running });
    this.planStatus = 'approved';
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.spawnCounts.clear();
    this.onHold.clear();
  }

  /**
   * Adopt an edited plan without letting go of the run in progress. Everything
   * the scheduler owns — live sessions, holds, retry counts, the verifier and
   * the review approval — survives, because `loadPlan` clears all of it and a
   * mid-run edit is not a new run. Only the tasks change.
   *
   * The ids with live sessions are defended: one dropped from the edited plan is
   * carried over (its verdict still has to land somewhere), and one whose status
   * the snapshot predates is put back to `in_progress` — adopting the snapshot's
   * "pending" would offer the scheduler work a runner is already doing.
   */
  reconcilePlan(newTasks: Task[], planRunners: RunnerId[] = ['claude-code']): void {
    const adopted = [...newTasks];
    for (const taskId of this.attempts.keys()) {
      const task = this.store.get(taskId);
      if (!task) continue;

      const at = adopted.findIndex((t) => t.id === taskId);
      if (at < 0) {
        adopted.push({ ...task });
      } else if (adopted[at].status !== 'in_progress') {
        console.warn(`[TaskOrchestrator] Running task "${task.title}" status changed to "${adopted[at].status}" in modified plan, using orchestrator truth`);
        adopted[at] = { ...adopted[at], status: 'in_progress' };
      }
    }

    this.store.load(adopted, planRunners);
    this.planStatus = 'running';
  }

  async start(): Promise<void> {
    if (this.runs.blocked) return;
    if (this.running) {
      console.error('[TaskOrchestrator] start() called but already running — no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked — plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
    if (!(await this.runs.open(() => this.start())) || this.running) return;
    console.log(`[TaskOrchestrator] Starting with ${this.store.allTasks.length} tasks (${this.store.allTasks.filter(t => t.type === 'ai' && t.prompt).length} AI ready)`);
    this.running = true;
    this.haltedByFailure = false;
    this.planStatus = 'running';
    this.emit('onTaskChanged');
    await this.tick();
  }

  private haltOnFailure(): void {
    if (this.running) this.haltedByFailure = true;
    this.running = false;
    this.planStatus = 'approved';
  }

  stop(): void {
    this.haltedByFailure = false;
    this.running = false;
    this.planStatus = 'approved';
    this.terminalRunner.stopAll();
    // Interrupted work is kept like a failed attempt's: inspectable, and off
    // `active` so a crash-recovery prune does not sweep it away. A stopped
    // repair did not land, so its task waits on the user as its conflict did.
    for (const a of this.endAllAttempts('stop')) {
      if (a.repair) this.store.markAwaitingUser(a.taskId);
      if (a.worktree) void this.runs.release(a.taskId, { keep: true }, a.integration);
    }
    this.runs.interrupt();
    this.onHold.clear();
    this.emit('onTaskChanged');
  }

  async onUserTaskComplete(taskId: string): Promise<void> {
    return this.markTaskComplete(taskId);
  }

  private async onVerdict(taskId: string, verdict: Verdict): Promise<void> {
    const task = this.store.get(taskId);
    const attempt = this.attempts.get(taskId);
    if (!task || !attempt) return;

    console.error(`[TaskOrchestrator] Task #${task.order} "${task.title}" verdict=${verdict.outcome}`);
    console.error(`[TaskOrchestrator] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
    console.error(`[TaskOrchestrator] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);
    if (attempt.repair) return this.settleRepair(task, attempt, verdict);

    // The terminal stays the source of truth for the verdict itself; this only
    // changes what gets summarized for downstream consumers.
    const doneToken = `<<<ORDEWELL_DONE_${task.completionMarker}>>>`;
    const summary = await this.output.finalText({ ...attempt, completionMarker: task.completionMarker }, doneToken);
    // The attempt stays live across the read, so a cancel, retry, mark
    // complete, stop or plan load in that window ends it — and has decided the
    // task since. A stale verdict must not overwrite that decision.
    if (this.attempts.get(taskId) !== attempt) return;
    const landing = verdict.outcome === 'pass' && attempt.worktree ? await this.integrate(task, attempt) : 'merged';
    if (this.attempts.get(taskId) !== attempt) return;
    this.endAttempt(taskId, 'verdict');
    this.store.setTaskVerdict(taskId, verdict);
    console.error(`[TaskOrchestrator] Output summary:\n${summary || '(empty — no output captured)'}`);
    if (verdict.outcome === 'pass') {
      await this.landPassed(task, landing);
    } else if (this.stoppedOnUsageLimit(attempt)) {
      // No marker, but what stopped the runner was its account rather than the
      // work. Failing would paint a red X on a task the user can simply retry,
      // and spawning more tasks would only spend the same exhausted limit, so
      // the task pauses and the run holds until the user resumes it.
      this.store.markAwaitingUser(taskId);
      this.haltOnFailure();
      this.tell('warn', `Task "${task.title}" stopped before its completion marker: ${attempt.runner} hit its usage limit. Retry it once the limit resets — its worktree is kept.`);
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    } else {
      this.store.markFailed(taskId);
      // Missing completion evidence is a hard boundary: do not launch more
      // work from a full-plan run until the user retries/resumes explicitly.
      // Already-active parallel tasks may finish, but no new task is spawned.
      this.haltOnFailure();
      this.notifications.error(`Task "${task.title}" failed verification: ${verdict.reason}`);
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    }

    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, summary));

    this.logAndArchive(task, verdict);
    await this.afterVerdict();
  }

  /** Whether a stopped runner's own tail says its account, not the task, ran out. */
  private stoppedOnUsageLimit(attempt: TaskAttempt): boolean {
    const tail = attempt.session?.getOutput().slice(-USAGE_LIMIT_TAIL) ?? '';
    return USAGE_LIMIT_RE.test(tail);
  }

  private async afterVerdict(): Promise<void> {
    this.emit('onTaskChanged');
    if (!this.running) {
      if (this.attempts.size === 0) {
        if (this.store.isAllComplete()) this.planStatus = 'completed';
        this.emit('onTick');
        await this.runs.close();
        this.emit('onExecutionComplete');
      }
      return;
    }
    await this.tick();
  }

  /**
   * A repair's verdict decides only whether its work may try to land. It never
   * replaces the verdict the task's own work earned, and a repair that does not
   * land leaves the task waiting on the user — never a failed task, so never a
   * halted run.
   */
  private async settleRepair(task: Task, attempt: TaskAttempt, verdict: Verdict): Promise<void> {
    const landed = verdict.outcome === 'pass' ? await this.landRepair(task, attempt) : null;
    if (this.attempts.get(task.id) !== attempt) return;
    this.endAttempt(task.id, 'verdict');
    if (!landed) await this.unrepaired(task, `did not finish (${verdict.reason})`);
    else if (!landed.evidence.ok) await this.unrepaired(task, this.describeEvidence(landed.evidence));
    else if (landed.outcome === 'merged') await this.landedRepair(task, verdict);
    else this.landUnmerged(task, landed.outcome);
    await this.afterVerdict();
  }

  /**
   * Evidence before the queue: the repair's work is committed and checked, and
   * only then merged, through the same serialized landing as any other task —
   * so a repair the tip has moved past again is a fresh conflict, not a pass.
   */
  private async landRepair(task: Task, attempt: TaskAttempt): Promise<{ evidence: RepairEvidence; outcome: IsolationOutcome }> {
    const run = this.runs.current;
    let evidence: RepairEvidence = { ok: false, reason: 'failed', repo: SELF_REPO };
    if (!run) return { evidence, outcome: 'failed' };
    attempt.phase = 'integrating';
    attempt.integration = (async (): Promise<IsolationOutcome> => {
      evidence = await this.isolation.verifyRepair(task, run).catch((): RepairEvidence => ({ ok: false, reason: 'failed', repo: run.tasks[task.id]?.conflictRepo ?? SELF_REPO }));
      if (evidence.ok) return this.integrateWork(task);
      await this.runs.release(task.id, { keep: true });
      return 'conflict';
    })();
    const outcome = await attempt.integration;
    return { evidence, outcome };
  }

  private async landedRepair(task: Task, verdict: Verdict): Promise<void> {
    const files = this.runs.current?.tasks[task.id]?.repairedFiles ?? [];
    this.store.markCompleted(task.id);
    this.store.unblockDependents(task.id);
    this.logAndArchive(task, task.verdict ?? verdict);
    this.tell('info', `Task "${task.title}" landed after repairing a conflict${files.length > 0 ? ` in ${capConflictFiles(files)}` : ''}.`);
    await this.landResolved(task.id);
  }

  /** A repair that did not land leaves the task as its conflict did: waiting on the user, worktree and refs kept. */
  private async unrepaired(task: Task, why: string): Promise<void> {
    await this.runs.release(task.id, { keep: true });
    this.store.markAwaitingUser(task.id);
    const group = this.runs.current?.repos.some((r) => r.path !== SELF_REPO);
    this.tell('warn', `The conflict repair of task "${task.title}" ${why}, so it did not land. Its ${group ? 'worktrees are' : 'worktree is'} kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.`);
  }

  private describeEvidence(evidence: Exclude<RepairEvidence, { ok: true }>): string {
    const run = this.runs.current;
    const inRepo = evidence.repo !== SELF_REPO ? ` in ${evidence.repo}` : '';
    const branch = run ? integrationBranchNameOf(run) : 'the integration branch';
    switch (evidence.reason) {
      case 'not-merged': return `finished, but its branch${inRepo} does not contain ${branch}`;
      case 'conflict-markers': {
        const files = (evidence.files ?? []).map((file) => (evidence.repo !== SELF_REPO ? `${evidence.repo}/${file}` : file));
        return `finished, but left conflict markers in ${capConflictFiles(files)}`;
      }
      case 'failed': return `finished, but git could not check its work${inRepo}`;
    }
  }

  /**
   * Merge a passed attempt's worktree. The attempt stays live while it waits on
   * the module's merge queue, so a cancel, retry or stop in that window still
   * wins, and nothing counts the task as done before its work is on the
   * integration branch.
   */
  private async integrate(task: Task, attempt: TaskAttempt): Promise<IsolationOutcome> {
    if (!this.hasUnlandedWork(task.id)) return 'failed';
    attempt.phase = 'integrating';
    attempt.integration = this.integrateWork(task);
    return attempt.integration;
  }

  /** A worktree whose work is not on the integration branch yet. */
  private hasUnlandedWork(taskId: string): boolean {
    const record = this.runs.current?.tasks[taskId];
    return !!record && record.status !== 'merged';
  }

  private async integrateWork(task: Task): Promise<IsolationOutcome> {
    const run = this.runs.current;
    if (!run) return 'failed';
    // Saved before the first merge, so a crash mid-landing leaves the tips to roll back to.
    const outcome = await this.isolation.integrate(task, run, () => this.emit('onIsolationChanged')).catch((): IsolationOutcome => 'failed');
    this.emit('onIsolationChanged');
    return outcome;
  }

  /** Settle a task whose work passed, by what its integration reported. */
  private async landPassed(task: Task, landing: IsolationOutcome): Promise<void> {
    if (landing !== 'merged') return this.landUnmerged(task, landing);
    this.store.markCompleted(task.id);
    this.notifications.info(`Task "${task.title}" completed.`);
    await this.landResolved(task.id);
  }

  private landUnmerged(task: Task, landing: Exclude<IsolationOutcome, 'merged'>): void {
    const branch = this.runs.current ? integrationBranchNameOf(this.runs.current) : 'the integration branch';
    const record = this.runs.current?.tasks[task.id];
    // Named only where there is a repo to name: a group of one reads as it always has.
    const inRepo = record?.conflictRepo && record.conflictRepo !== SELF_REPO ? record.conflictRepo : null;
    if (landing === 'conflict') {
      // Never resolved here: the first answer is a bounded repair by the task
      // itself, on a new attempt in its own worktree (ADR-0015); until one
      // lands, the task's dependents wait on it.
      const repair = this.nextRepair(task.id);
      this.store.markAwaitingUser(task.id);
      const files = record?.conflictFiles?.length ? ` (${capConflictFiles(record.conflictFiles)})` : '';
      const conflicted = inRepo
        ? `Task "${task.title}" passed, but landing it on ${branch} conflicted in ${inRepo}${files}, so none of it landed.`
        : `Task "${task.title}" passed, but merging it into ${branch} conflicted${files}.`;
      if (repair) {
        this.notifications.warn(conflicted);
        // The slot the ending attempt freed, never one more than the run allows.
        if (this.attempts.size < this.config.maxParallelSessions) void this.startTask(task);
        else {
          this.store.markPending(task.id);
          this.tell('info', `Task "${task.title}" is repaired once a slot is free.`);
        }
        return;
      }
      this.notifications.warn(`${conflicted} ${inRepo ? 'Its worktrees are' : 'Its worktree is'} kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.`);
      const whyNot = this.noRepairReason(task);
      if (whyNot) this.tell('info', whyNot);
    } else {
      // The verdict passed; only the landing did not. A red X would say the
      // task failed verification and contradict the marker evidence, so it
      // waits on the user like a conflict does, with its work kept.
      const why = record?.landingError ? ` (${record.landingError})` : '';
      this.store.markAwaitingUser(task.id);
      this.notifications.error(inRepo
        ? `Task "${task.title}" passed, but git could not integrate its work in ${inRepo}${why}, so none of it landed. Its worktrees are kept for inspection.`
        : `Task "${task.title}" passed, but git could not integrate its work${why}. Its worktree is kept for inspection.`);
    }
  }

  /** The repair a conflicted task is owed next; null when repair is off, used up, or there is no isolated run to repair it in. */
  private nextRepair(taskId: string): RepairAttempt | null {
    const record = this.runs.openRecord(taskId);
    const limit = this.config.conflictRepairAttempts;
    const spent = record?.repairs ?? 0;
    return record?.status === 'conflict' && spent < limit ? { n: spent + 1, limit } : null;
  }

  private noRepairReason(task: Task): string | null {
    const limit = this.config.conflictRepairAttempts;
    if (limit === 0) return `Conflict repair is off (conflictRepairAttempts is 0), so task "${task.title}" waits for you.`;
    const spent = this.runs.current?.tasks[task.id]?.repairs ?? 0;
    return spent >= limit ? `Task "${task.title}" has had ${spent} of its ${limit} conflict repairs, so its conflict waits for you.` : null;
  }

  /**
   * Mark which added task resolves which conflict. The resolver merges the
   * conflicted task's branch by hand in its own worktree; once that lands, the
   * conflicted task's branch is already on the integration branch and it can
   * land in turn — through the same merge, so a resolver that did not really
   * bring it along conflicts again instead of being taken at its word.
   */
  linkConflictResolver(resolverId: string, conflictedId: string): void {
    this.runs.linkResolver(resolverId, conflictedId);
  }

  private async landResolved(resolverId: string): Promise<void> {
    const conflictedId = this.runs.takeResolver(resolverId);
    if (!conflictedId) return;
    const conflicted = this.store.get(conflictedId);
    // Only the conflict it was added for: a task retried since has a new
    // attempt of its own, whose worktree it would merge half-done.
    if (!conflicted || this.runs.current?.tasks[conflictedId]?.status !== 'conflict') return;
    const landing = await this.integrateWork(conflicted);
    if (landing !== 'merged') return this.landUnmerged(conflicted, landing);
    this.store.markCompleted(conflictedId);
    this.store.unblockDependents(conflictedId);
    if (conflicted.verdict) this.logAndArchive(conflicted, conflicted.verdict);
    this.notifications.info(`Task "${conflicted.title}" landed through its conflict resolution.`);
  }

  getReadyTasks(): Task[] {
    if (!this.running) return [];
    const maxParallel = this.config.maxParallelSessions;
    const currentActive = this.attempts.size;
    if (currentActive >= maxParallel) return [];
    const availableSlots = maxParallel - currentActive;

    const candidates = this.store.allTasks.filter((t) => {
      if (t.status !== 'pending' && t.status !== 'approved') return false;
      if (t.type === 'user') return false;
      if (!t.prompt) return false;
      if (this.onHold.has(t.id)) return false;
      if (this.isBlocked(t)) return false;
      if (!t.dependencies.every((depId) => this.dependencyMet(depId))) return false;
      return true;
    });

    const excluded = this.store.allTasks.filter(t => t.type === 'ai' && t.prompt && !candidates.includes(t));
    if (excluded.length > 0) {
      for (const t of excluded) {
        const reasons: string[] = [];
        if (t.status !== 'pending' && t.status !== 'approved') reasons.push(`status=${t.status}`);
        if (this.onHold.has(t.id)) reasons.push('on-hold');
        if (this.isBlocked(t)) reasons.push('blocked');
        if (!t.dependencies.every((depId) => this.dependencyMet(depId))) reasons.push('deps');
        console.log(`[TaskOrchestrator] excluded: #${t.order} "${t.title}" — ${reasons.join(', ')}`);
      }
    }

    console.log(`[TaskOrchestrator] getReadyTasks: ${candidates.length} candidates, ${availableSlots} slots, maxParallel=${maxParallel}`);
    return candidates.sort((a, b) => a.order - b.order).slice(0, availableSlots);
  }

  /**
   * In an isolated run a dependency is met once its work is on the integration
   * branch, not merely once it passed: the dependent's worktree is cut from
   * that branch, so starting earlier would hand it a tree without the work it
   * depends on.
   */
  private dependencyMet(depId: string): boolean {
    if (!this.store.isCompleted(depId)) return false;
    const record = this.runs.openRecord(depId);
    return !record || record.status === 'merged';
  }

  isBlocked(task: Task): boolean {
    if (task.status === 'blocked') return true;
    if (task.dependencies.length > 0) return task.dependencies.some((depId) => this.store.isFailed(depId));
    return false;
  }

  /**
   * Cancel a running (or scheduled) task: kill its session and return it to
   * 'pending' — "not executed". The task is put on hold so the scheduler
   * doesn't immediately restart it; Retry / Force Start release the hold.
   *
   * The attempt's worktree is kept, as a stopped or failed one is: a runner is
   * often cancelled because it looked stuck after doing the work, and Mark
   * complete can still land that work. The next attempt replaces it.
   */
  async cancelTask(taskId: string): Promise<void> {
    await this.cancelAttempt(taskId, { keep: true });
  }

  private async cancelAttempt(taskId: string, worktree: { keep: boolean }): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    const ended = this.endAttempt(taskId, 'cancel');
    this.store.markPending(taskId);
    this.onHold.add(taskId);
    this.emit('onTaskChanged');
    await this.runs.release(taskId, worktree, ended?.integration);
    await this.tick();
  }

  /**
   * Let go of a task that is leaving the plan. A live runner is cancelled
   * as {@link cancelTask} does, but its worktree goes: no task is left to land
   * it into. A spawn still in flight just loses its attempt,
   * which is what makes {@link startTask} kill the session it is about to
   * receive. The id's cross-attempt bookkeeping goes too — a hold or retry
   * count kept for a task that no longer exists would be inherited by nothing.
   */
  async releaseTask(taskId: string): Promise<void> {
    const phase = this.attempts.get(taskId)?.phase;
    if (phase === 'running' || phase === 'integrating') await this.cancelAttempt(taskId, { keep: false });
    else {
      this.endAttempt(taskId, 'release');
      await this.runs.release(taskId, { keep: false });
    }
    this.onHold.delete(taskId);
    this.retryCounts.delete(taskId);
    this.spawnCounts.delete(taskId);
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return;

    const ended = this.endAttempt(taskId, 'complete');
    const verdict = this.verifier.markComplete(task);
    // The user vouches for the work, so it lands the way a passed verdict's
    // would — including a merge a passed verdict already has in flight.
    const merging = ended?.integration ?? (this.hasUnlandedWork(taskId) ? this.integrateWork(task) : null);
    const landing = merging ? await merging : 'merged';

    if (landing === 'merged') this.store.markCompleted(taskId);
    else this.landUnmerged(task, landing);
    this.store.setTaskVerdict(taskId, verdict);
    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, ''));
    this.logAndArchive(task, verdict);
    if (landing === 'merged') {
      this.store.unblockDependents(taskId);
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      await this.landResolved(taskId);
    }

    this.emit('onTaskChanged');
    await this.tick();
  }

  async markAiTaskComplete(taskId: string): Promise<void> {
    return this.markTaskComplete(taskId);
  }

  /**
   * Undo a completion: return the task to "not executed" — pending, verdict and
   * summary dropped, archive entry removed. It is put on hold like a cancel, so
   * a running plan does not immediately re-spawn the work the user just
   * un-marked; Retry / Force Start / Run release the hold. Dependents fall back
   * to waiting on their own, because the scheduler gates on `isCompleted`.
   */
  async markTaskIncomplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'completed') return;

    this.verifier.clear(task);
    this.store.retry(taskId);
    this.store.removeFromLog(taskId);
    this.onHold.add(taskId);
    // A finished plan is no longer finished — leaving 'completed' would tell
    // every surface the run is over while a task sits pending.
    if (this.planStatus === 'completed') this.planStatus = 'approved';

    this.notifications.info(`Task "${task.title}" marked not done.`);
    this.emit('onTaskChanged');
    await this.tick();
  }

  private logAndArchive(task: Task, verdict: Verdict): void {
    const snapshot: TaskSnapshot = {
      ...task,
      completedAt: Date.now(),
      verdict,
      retryCount: this.retryCounts.get(task.id) ?? 0,
      finalized: true,
    };
    this.store.appendToLog(snapshot);
    // Completed tasks remain in the active plan tree so the UI can keep
    // showing them alongside pending and running work.
  }

  async retryTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    const ended = this.endAttempt(taskId, 'retry');
    this.store.retry(taskId);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    this.emit('onTaskChanged');
    // A retry starts over from the integration tip, which by now holds what its
    // predecessors landed; the old attempt's worktree has nothing to offer it.
    await this.runs.release(taskId, { keep: false }, ended?.integration);
    if (this.haltedByFailure && !this.running) await this.start();
    else await this.tick();
  }

  /**
   * Manually start a single AI task right now, bypassing dependency/readiness
   * gating (the "force start" affordance on a task card). Reuses the scheduler's
   * own startTask so a force-started task gets the same augmented prompt, session
   * tracking, and exit handling — callers must not re-spawn the runner themselves.
   * No-op if the task is unknown, not an AI task, or already running.
   */
  async forceStartTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    if (this.attempts.has(taskId)) return;
    if (!(await this.runs.open(() => this.forceStartTask(taskId)))) return;
    this.onHold.delete(taskId);
    await this.startTask(task);
  }

  /**
   * Run exactly one task outside full-plan scheduling. The active/starting
   * session still contributes to {@link hasLiveWork} so every surface exposes
   * Stop and disables Execute Plan, but onVerdict cannot auto-schedule other
   * tasks because the plan scheduler's `running` flag remains false.
   */
  async runTask(taskId: string): Promise<void> {
    if (this.hasLiveWork) return;
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    if (!(await this.runs.open(() => this.runTask(taskId)))) return;
    this.onHold.delete(taskId);
    await this.startTask(task);
  }

  getCompletedCount(): number { return this.store.completedCount; }
  getTotalCount(): number { return this.store.allTasks.length; }
  isAllComplete(): boolean { return this.store.isAllComplete(); }
  isAnyFailed(): boolean { return this.store.isAnyFailed(); }

  async approveReview(): Promise<void> {
    if (this.reviewApproved) {
      console.log('[TaskOrchestrator] approveReview() called but already approved — no-op');
      return;
    }
    this.reviewApproved = true;
    this.planStatus = 'approved';
    this.emit('onTaskChanged');
    this.emit('onReviewApproved', { tasks: this.store.planTasks });
    await this.start();
  }

  getPlanVisualization() { return this.store.getPlanVisualization(); }

  async tick(): Promise<void> {
    if (!this.running) {
      // A run the scheduler is not driving — a manual task run, or a halted
      // plan's remaining attempts — is closed by a verdict only. Ended by
      // cancel, Mark complete or a failed spawn instead, it would stay open, and
      // the next run would inherit its mode rather than decide its own.
      if (this.attempts.size === 0 && this.runs.isOpen) await this.runs.close();
      return;
    }

    if (this.messageQueue.length > 0) {
      if (this.attempts.size === 0) {
        this.emit('onQueueReady');
      }
      return;
    }

    const ready = this.getReadyTasks();
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.attempts.size} active, queue=${this.messageQueue.length}`);

    if (ready.length === 0 && this.attempts.size === 0) {
      const remaining = this.store.allTasks.filter(t => t.status !== 'completed');
      console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
      const remainingById = new Map(remaining.map((t) => [t.id, t]));
      for (const { task, parent } of flattenTasksWithParents(this.store.planTasks)) {
        if (!remainingById.has(task.id)) continue;
        console.log(`  - ${taskOrderLabel(task, parent ?? undefined)}. ${task.title} [${task.type}/${task.status}] prompt=${!!task.prompt}`);
      }
      if (this.store.isAllComplete()) {
        // Genuinely done — stop the loop so a fresh Execute click can start it again.
        this.running = false;
        this.planStatus = 'completed';
        this.notifications.info('All tasks completed!');
        this.emit('onTaskChanged');
        this.emit('onTick');
        await this.runs.close();
        this.emit('onExecutionComplete');
      } else {
        // Not done — just waiting on a user task, checkpoint, or held task.
        // Keep `running` true: markTaskComplete/retryTask/forceStartTask/cancelTask
        // all re-tick() afterward, and that only ever schedules new work while
        // `running` is true. Flipping it false here would silently kill the
        // scheduler and leave dependents unblocked-but-never-started.
        // Do NOT emit onExecutionComplete here: a paused run is not a finished
        // one, and every surface treats that signal as terminal (the TUI closes
        // its execution stream on receipt, so a later fan-out from completing the
        // user task would arrive to a closed socket and be invisible).
        this.notifications.info('Remaining tasks require user action or are on hold.');
        this.emit('onTaskChanged');
        this.emit('onTick');
      }
      return;
    }

    for (const task of ready) await this.startTask(task);
    this.emit('onTick');
  }

  private async startTask(task: Task): Promise<void> {
    if (this.attempts.has(task.id)) return;
    const attempt: TaskAttempt = {
      taskId: task.id,
      attempt: (this.spawnCounts.get(task.id) ?? 0) + 1,
      phase: 'starting',
      session: null,
      runner: this.store.resolveTaskRunner(task),
      cwd: null,
      worktree: false,
      integration: null,
      repair: this.nextRepair(task.id),
      startedAt: new Date().toISOString(),
    };
    this.spawnCounts.set(task.id, attempt.attempt);
    this.attempts.set(task.id, attempt);
    this.store.markInProgress(task.id);
    this.emit('onTaskChanged');

    if (!(await this.spawnAttempt(task, attempt))) return;

    // Committed as running: notify observers only now, outside the fallible
    // spawn path above, so an observer throwing here is never mistaken for a
    // failed spawn (which would tear down the attempt it just announced).
    if (attempt.worktree) this.emit('onIsolationChanged');
    this.emit('onTaskChanged');
    if (attempt.repair) {
      const group = this.runs.current?.repos.some((r) => r.path !== SELF_REPO);
      this.tell('info', `Repairing the conflict of task "${task.title}" in its own ${group ? 'worktrees' : 'worktree'} (repair ${attempt.repair.n} of ${attempt.repair.limit}).`);
    } else {
      this.notifications.info(`Task "${task.title}" started (${attempt.runner})`);
    }
  }

  /**
   * The fallible half of starting a task: resolving its cwd/worktree and
   * spawning the runner. Resolves false when the attempt never committed —
   * abandoned because it was ended from under it, or a failed spawn already
   * unwound (both leave `startTask` with nothing further to announce).
   */
  private async spawnAttempt(task: Task, attempt: TaskAttempt): Promise<boolean> {
    try {
      const { cwd, worktree } = await this.runs.attemptCwd(task, { repair: attempt.repair !== null });
      attempt.cwd = cwd;
      attempt.worktree = worktree;
      if (this.attempts.get(task.id) !== attempt) {
        // Ended while its worktree was being made, so whatever ended it could
        // not release it. A newer attempt's own prepare replaces it instead.
        // A repair's worktree holds work that passed, so it is only handed back.
        if (attempt.worktree && !this.attempts.has(task.id)) await this.runs.release(task.id, { keep: attempt.repair !== null });
        this.abandonSpawn(task, attempt);
        return false;
      }
      // Through the same augmenting as any spawn, so the marker is the task's
      // own and the VerdictEngine watches for it unchanged.
      const finalPrompt = composeAugmentedPrompt(attempt.repair ? { ...task, prompt: this.repairPrompt(task) } : task, this.store.planTasks, {
        planMapEnabled: this.config.planMapEnabled,
        // A merge to resolve is not new behaviour to drive test-first.
        tddEnabled: !attempt.repair && this.tddEnabled(),
      });
      this.closeLingering(task.id);
      const env = await this.envForTask(cwd);
      const session = await this.terminalRunner.spawn({
        taskId: task.id,
        runner: attempt.runner,
        prompt: finalPrompt,
        modelId: task.assignedModel?.modelId,
        thinkingEffort: task.assignedModel?.thinkingEffort,
        modelVariants: task.assignedModel?.availableVariants,
        mode: task.taskMode ?? 'build',
        cwd,
        registry: this.registry ?? undefined,
        order: task.order,
        title: task.title,
        env,
      });

      // Stop/load/cancel can end the attempt while the async adapter is
      // starting. Do not resurrect that execution after the surface already
      // went idle — and compare identity, not presence, because a newer
      // attempt of the same task may have been claimed in the meantime.
      if (this.attempts.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt, session);
        return false;
      }
      attempt.phase = 'running';
      attempt.session = session;

      // Attached before the verifier so the chunk that carries the marker is
      // captured before that chunk's verdict asks for the final text.
      this.output.attach(task.id, session);
      this.verifier.watch(task, session);
      this.watchBlockingPrompts(task, attempt, session);
      return true;
    } catch (err) {
      if (this.attempts.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt);
        return false;
      }
      this.endAttempt(task.id, 'spawn-failed');
      if (attempt.repair) {
        await this.unrepaired(task, `could not start: ${err instanceof Error ? err.message : String(err)}`);
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      await this.runs.release(task.id, { keep: false });
      // Couldn't spawn — the task was never executed, so it stays "to do".
      // Held out of auto-scheduling to avoid a spawn-throw retry loop.
      this.store.markPending(task.id);
      this.onHold.add(task.id);
      this.tell('error', `Failed to start task "${task.title}": ${err}`);
      this.emit('onTaskChanged');
      await this.tick();
      return false;
    }
  }

  /**
   * A spawn whose attempt ended while it was in flight: kill what it produced
   * and take back the claim it made. Only the claim — whatever ended the
   * attempt may have decided the task since (mark complete, cancel, retry).
   */
  private abandonSpawn(task: Task, attempt: TaskAttempt, session?: ITerminalSession): void {
    session?.kill();
    if (this.attempts.has(task.id) || this.store.get(task.id)?.status !== 'in_progress') return;
    if (attempt.repair) this.store.markAwaitingUser(task.id);
    else this.store.markPending(task.id);
    this.emit('onTaskChanged');
  }

  private repairPrompt(task: Task): string {
    const run = this.runs.requireRun();
    const record = run.tasks[task.id];
    const conflict = {
      branch: record?.branch ?? '',
      repos: Object.keys(record?.repairBase ?? {}),
      ...(record?.conflictRepo ? { conflictRepo: record.conflictRepo } : {}),
      ...(record?.conflictFiles ? { conflictFiles: record.conflictFiles } : {}),
    };
    return buildConflictRepairPrompt(task, conflict, integrationBranchNameOf(run));
  }

  private tell(level: 'info' | 'warn' | 'error', message: string): void {
    this.notifications[level](message);
    this.emit('onIsolationNotice', { level, message });
  }

  /**
   * Whether the run in force, or else the next one, gives each task its own
   * worktrees, and of which repo group — what the planner is told.
   */
  async plannerIsolation(): Promise<IsolatedExecution> {
    return this.runs.plannerLayout();
  }

  /**
   * Replay the start a dirty tree turned away. `stash` puts the user's tracked
   * changes on the git stash first, so the run isolates; `shared` runs this one
   * run in the workspace root, knowingly.
   */
  async continueBlockedRun(how: 'stash' | 'shared'): Promise<void> {
    const resume = await this.runs.continueBlocked(how);
    if (resume) await resume();
  }

  /**
   * The one way an attempt ends. Dropping the record is itself what
   * invalidates a spawn still in flight ({@link startTask} kills the session
   * it receives for an attempt that is no longer current).
   *
   * A user interruption also bumps the verifier's generation *before* stopping
   * the runner: some runners (e.g. tmux) fire onExit synchronously from
   * stop(), and if that exit reaches VerdictEngine under the still-valid
   * generation it delivers a verdict that marks the task 'completed' for one
   * tick — long enough for the scheduler to start a dependent task. A verdict
   * leaves the runner up so its terminal stays readable, and stop/load reset
   * the whole verifier themselves.
   */
  private endAttempt(taskId: string, reason: AttemptEnd): TaskAttempt | undefined {
    const attempt = this.attempts.get(taskId);
    this.attempts.delete(taskId);
    if (attempt) this.output.detach(taskId);
    if (reason === 'verdict' && attempt?.session) this.lingering.set(taskId, attempt.session.id);
    if (reason === 'cancel' || reason === 'release' || reason === 'complete' || reason === 'retry' || reason === 'spawn-failed') {
      const task = this.store.get(taskId);
      if (task) this.verifier.clear(task);
      if (attempt?.session) this.terminalRunner.stop(attempt.session.id);
    }
    return attempt;
  }

  private endAllAttempts(reason: 'stop' | 'load'): TaskAttempt[] {
    const ended = [...this.attempts.values()];
    for (const { taskId } of ended) this.endAttempt(taskId, reason);
    this.verifier.reset();
    if (reason === 'load') this.output.reset();
    return ended;
  }
}
