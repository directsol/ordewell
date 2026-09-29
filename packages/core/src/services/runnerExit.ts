import type { RunnerTransport } from '../interfaces/ITerminalRunner';

/**
 * What a stopped runner says about why it stopped, and what ending an attempt
 * does to the runner it leaves behind. TaskOrchestrator acts on the answers;
 * the only terminal touch here is the stop callback a {@link LingeringRunners}
 * is handed.
 */

/**
 * Why a runner stopped, as far as the tail of its own output says. `usage-limit`
 * is the account, not the task, running out; anything else is `stopped`.
 */
export type RunnerStop = 'usage-limit' | 'stopped';

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

/** Classify a stopped runner from the tail of its own output. */
export function classifyRunnerStop(output: string): RunnerStop {
  return USAGE_LIMIT_RE.test(output.slice(-USAGE_LIMIT_TAIL)) ? 'usage-limit' : 'stopped';
}

/** Every way an attempt ends: a verdict, cancel, release, Mark complete, retry, a failed spawn, stop, plan load. */
export type AttemptEnd = 'verdict' | 'cancel' | 'release' | 'complete' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * A verdict leaves a terminal runner up so its screen stays readable. Every
 * other reason lets it go — cancel, complete, retry and a failed spawn stop it
 * here, while stop and load reset every runner at once.
 */
export function keepsTerminalReadable(reason: AttemptEnd, transport: RunnerTransport): boolean {
  return reason === 'verdict' && transport === 'terminal';
}

/**
 * Whether ending an attempt with this reason has to stop its own runner now.
 * A structured runner also ends on its verdict (ADR-0018, L1): its log lives
 * in Ordewell, and whatever it did after the verdict would go unverified.
 */
export function stopsRunner(reason: AttemptEnd, transport: RunnerTransport): boolean {
  if (reason === 'verdict') return transport === 'structured';
  return reason === 'cancel' || reason === 'release' || reason === 'complete' || reason === 'retry' || reason === 'spawn-failed';
}

/**
 * The runner a verdict left open, by task. It stays so the user can read the
 * agent's output or keep talking to it — but only while its worktree does: once
 * that is removed the agent sits in a deleted directory, and a newer attempt in
 * the same worktree would share it with a second agent. Without this, every
 * task of every run left one agent process running until the daemon stopped.
 */
export class LingeringRunners {
  private readonly sessions = new Map<string, string>();

  constructor(private readonly stop: (sessionId: string) => void) {}

  /** Keep a task's runner up for reading until its worktree goes or a newer attempt claims it. */
  remember(taskId: string, sessionId: string): void {
    this.sessions.set(taskId, sessionId);
  }

  /** Let a task's lingering runner go; a task without one is a no-op. */
  close(taskId: string): void {
    const sessionId = this.sessions.get(taskId);
    if (sessionId === undefined) return;
    this.sessions.delete(taskId);
    this.stop(sessionId);
  }
}
