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

/**
 * The input side of a call whose provider reports its prompt in parts — the
 * uncached tail, with cache reads and cache writes beside it rather than inside
 * it (Anthropic, and OpenCode after it). The prompt the model saw is all three;
 * only the reads were served from cache, since a write is billed as fresh
 * input. A part left unreported adds nothing, and with no part reported there
 * is no measure at all.
 */
export function partedPromptUsage(parts: { uncached?: number; cacheRead?: number; cacheWrite?: number }): Pick<UsageRecord, 'inputTokens' | 'cachedInputTokens'> {
  const reported = [parts.uncached, parts.cacheRead, parts.cacheWrite].filter((n): n is number => n !== undefined);
  return {
    ...(reported.length > 0 ? { inputTokens: reported.reduce((a, b) => a + b, 0) } : {}),
    ...(parts.cacheRead !== undefined ? { cachedInputTokens: parts.cacheRead } : {}),
  };
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
  // A reported window of 0 means "not known", not "no room": keep it out so the
  // fill is omitted rather than shown against a guessed zero.
  if (record.contextWindow !== undefined && record.contextWindow > 0) next.contextWindow = record.contextWindow;
  return next;
}

/** Whether any measure was reported: a token line of nothing but blanks says nothing. */
export function isMeasured(totals: UsageTotals): boolean {
  return totals.inputTokens !== undefined || totals.outputTokens !== undefined || totals.cachedInputTokens !== undefined
    || Object.keys(totals.reportedCost ?? {}).length > 0;
}

/** What the token line shows of a ledger — live from its broadcast, or reloaded from the saved one. */
export interface UsageLine {
  totals: UsageTotals;
  bySubagent?: Record<string, UsageTotals>;
  contextFill?: { usedTokens: number; windowTokens: number };
}

export function usageLine(usage: PlannerUsage): UsageLine {
  const contextFill = plannerContextFill(usage);
  return {
    totals: usage.totals,
    ...(usage.bySubagent ? { bySubagent: usage.bySubagent } : {}),
    ...(contextFill ? { contextFill } : {}),
  };
}

/**
 * The last planner prompt against its window, or undefined while either is
 * unknown. `usedTokens` is the prompt total as reported, cached tokens
 * included: a cached token still occupies the window, so subtracting the
 * cached share would understate how full the context is. A window of 0 is
 * treated as unknown — never guessed.
 */
export function plannerContextFill(usage: PlannerUsage): { usedTokens: number; windowTokens: number } | undefined {
  if (usage.lastPromptTokens === undefined || usage.contextWindow === undefined || usage.contextWindow <= 0) return undefined;
  return { usedTokens: usage.lastPromptTokens, windowTokens: usage.contextWindow };
}
