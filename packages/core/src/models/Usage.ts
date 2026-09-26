/**
 * What one model call consumed, as its provider or runner reported it. Shared
 * by the planner's usage line (#49) and per-attempt task usage (#26): a record
 * says nothing about who asked for the call, so either can hold a list of them.
 *
 * Every measure is optional because backends report different subsets. An
 * absent field means "not reported" — never zero — so a total can tell the two
 * apart.
 */
export interface UsageRecord {
  /** The provider or runner id that reported the call — `openai`, `claude-code`, … */
  source: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The share of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /**
   * Filled only from a provider's or runner's own report, never from a price
   * table or an estimate: prices go stale, and a subscription runner has no
   * per-token price at all. No report means no cost, not a guessed one.
   */
  reportedCost?: { amount: number; currency: string };
  /** The model's context window, when the runner itself reports it. */
  contextWindow?: number;
  /** Set when a subagent made the call; its usage still counts toward the total. */
  subagentId?: string;
}

/**
 * A running sum of {@link UsageRecord}s. A measure stays absent until some
 * record reports it. Cost is kept per currency: two runners may bill in
 * different ones, and there is no honest exchange rate to fold them together.
 */
export interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reportedCost?: Record<string, number>;
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const;

export function addUsage(totals: UsageTotals, record: UsageRecord): UsageTotals {
  const next: UsageTotals = { ...totals };
  for (const field of TOKEN_FIELDS) {
    const reported = record[field];
    if (reported !== undefined) next[field] = (totals[field] ?? 0) + reported;
  }
  if (record.reportedCost) {
    const { amount, currency } = record.reportedCost;
    next.reportedCost = { ...totals.reportedCost, [currency]: (totals.reportedCost?.[currency] ?? 0) + amount };
  }
  return next;
}

/**
 * What the planner has consumed over a session (#49). `totals` includes every
 * `bySubagent` entry. `lastPromptTokens` and `contextWindow` track the
 * planner's own calls only — a subagent runs its own model, whose window says
 * nothing about the planner's.
 */
export interface PlannerUsage {
  totals: UsageTotals;
  bySubagent?: Record<string, UsageTotals>;
  lastPromptTokens?: number;
  contextWindow?: number;
}

export function addPlannerUsage(usage: PlannerUsage, record: UsageRecord): PlannerUsage {
  const next: PlannerUsage = { ...usage, totals: addUsage(usage.totals, record) };
  if (record.subagentId) {
    next.bySubagent = { ...usage.bySubagent, [record.subagentId]: addUsage(usage.bySubagent?.[record.subagentId] ?? {}, record) };
    return next;
  }
  if (record.inputTokens !== undefined) next.lastPromptTokens = record.inputTokens;
  if (record.contextWindow !== undefined) next.contextWindow = record.contextWindow;
  return next;
}

/** The last planner prompt against its window, or undefined while either is unknown. */
export function plannerContextFill(usage: PlannerUsage): { usedTokens: number; windowTokens: number } | undefined {
  if (usage.lastPromptTokens === undefined || usage.contextWindow === undefined) return undefined;
  return { usedTokens: usage.lastPromptTokens, windowTokens: usage.contextWindow };
}
