/**
 * The planner's single approval seam. Every capability that reaches beyond the
 * default read-only, in-workspace envelope — a path outside the workspace root,
 * a shell command outside the auto-allowed set, a URL fetch — routes through
 * one `request()` so the policy has exactly one owner (the same "one repair
 * owner" shape as PlanRepair).
 *
 * Surfaces supply the human channel. VS Code answers with a modal; the web
 * server currently has no prompt UI, so it denies unless the scope was
 * pre-approved through config. Denial is always a visible, actionable tool
 * result — never a silent success.
 */

/**
 * `runner_tool` is a task runner's own tool request (ADR-0018, A1): it waits
 * for an answer as long as it takes, and never passes through the planner's
 * policy — the runner's mode already decided it needed asking.
 */
export type ApprovalKind = 'external_path' | 'shell_command' | 'url_fetch' | 'runner_tool';

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** The concrete thing being asked about: an absolute path, a command line, a URL. */
  subject: string;
  /**
   * What a grant covers. Approving remembers this, not `subject`, so reading a
   * second file from an already-approved directory does not prompt again.
   */
  scope: string;
  /** One-line context for the prompt. */
  detail?: string;
  /** The task whose runner asked; absent for the planner's own requests. */
  taskId?: string;
  /** "Allow for this task" can be offered: the runner proposed its own session-scoped grant. */
  allowForTask?: boolean;
}

/**
 * An answer, from whoever gives it — a person on any surface, or later the
 * supervisor (#28). `allowForTask` is Allow plus the runner's own grant for
 * the rest of the task; `note` goes back to the agent with a denial.
 */
export type ApprovalDecision =
  | { decision: 'allow' }
  | { decision: 'allowForTask' }
  | { decision: 'deny'; note?: string };

/** What an answer may be given as: a planner prompt's yes/no still is one. */
export type ApprovalAnswer = boolean | ApprovalDecision;

export function toApprovalDecision(answer: ApprovalAnswer): ApprovalDecision {
  if (typeof answer === 'boolean') return { decision: answer ? 'allow' : 'deny' };
  return answer;
}

export function isGranted(decision: ApprovalDecision): boolean {
  return decision.decision !== 'deny';
}

export function isRunnerApproval(request: ApprovalRequest): boolean {
  return request.kind === 'runner_tool';
}

export interface IApproval {
  request(req: ApprovalRequest): Promise<boolean>;
}

/** Denies everything. The safe default when a surface wires no approval channel. */
export const DENY_ALL: IApproval = {
  async request() { return false; },
};
