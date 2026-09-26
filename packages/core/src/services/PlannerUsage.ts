import {
  addPlannerUsage,
  plannerContextFill,
  type PlannerUsage,
  type UsageRecord,
} from '../models/Usage';
import type { SessionMessage } from './SessionMessage';

/** The `planner_usage` member of the session broadcast union. */
export type PlannerUsageMessage = Extract<SessionMessage, { type: 'planner_usage' }>;

/**
 * The planner's session usage ledger (#49), owned by Session. Consumes the
 * `usage` progress events a backend emits per model call, keeps the running
 * session and per-subagent totals, and renders the `planner_usage` message.
 * Session persists {@link snapshot} with the plan and restores it on load, so a
 * reopened session shows its totals again. The accumulation itself lives in
 * `models/Usage` — the one place the sum's currency-per-currency rule is
 * defined — this module just holds the state and the broadcast shape.
 */
export class PlannerUsageLedger {
  private usage: PlannerUsage = { totals: {} };

  /** Fold one model call's record into the totals; returns the running ledger. */
  record(record: UsageRecord): PlannerUsage {
    this.usage = addPlannerUsage(this.usage, record);
    return this.usage;
  }

  /** Adopt a persisted ledger (a reopened session) or start from zero. */
  restore(usage: PlannerUsage | undefined): void {
    this.usage = usage ?? { totals: {} };
  }

  /** Start a fresh session's ledger from zero. */
  clear(): void {
    this.usage = { totals: {} };
  }

  /** Whether anything has been recorded — a plan with no usage says nothing. */
  get hasUsage(): boolean {
    const { totals } = this.usage;
    return totals.inputTokens !== undefined
      || totals.outputTokens !== undefined
      || totals.cachedInputTokens !== undefined
      || Object.keys(totals.reportedCost ?? {}).length > 0;
  }

  /** The value persisted onto the plan state. */
  snapshot(): PlannerUsage {
    return { ...this.usage };
  }

  /** The broadcast message for the totals as they stand now. */
  message(turnId?: string): PlannerUsageMessage {
    const contextFill = plannerContextFill(this.usage);
    return {
      type: 'planner_usage',
      ...(turnId ? { turnId } : {}),
      totals: this.usage.totals,
      ...(this.usage.bySubagent ? { bySubagent: this.usage.bySubagent } : {}),
      ...(contextFill ? { contextFill } : {}),
    };
  }
}
