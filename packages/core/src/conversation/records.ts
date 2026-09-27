import type { ResearchStep, ResearchStepOutcome } from '../models/Task';
import type { UsageTotals } from '../models/Usage';
import type { PlanMarkerStatus, ToolBlock, ToolStatus } from './blocks';
import { outputLines, toolHeadline } from './format';

/*
 * How the session's records — research steps, transcript markers, usage
 * totals — read as blocks. Shared by the live view and the reload, so the two
 * cannot disagree about what a record shows.
 */

const STATUS_OF_OUTCOME: Record<ResearchStepOutcome, ToolStatus> = {
  success: 'ok',
  failure: 'error',
  refused: 'denied',
  denied: 'denied',
  not_executed: 'interrupted',
};

export function settledTool(call: ToolBlock, step: ResearchStep): ToolBlock {
  return { ...call, status: STATUS_OF_OUTCOME[step.outcome], outcome: step.outcome, output: step.result, outputLineCount: outputLines(step.result).length };
}

export interface AnnouncedCall {
  tool: string;
  toolLabel?: string;
  args: string;
  toolCallId?: string;
  turnId?: string;
}

export function pendingTool(id: string, { tool, toolLabel, args, toolCallId, turnId }: AnnouncedCall): ToolBlock {
  return {
    type: 'tool', id, tool, headline: toolHeadline(tool, args, toolLabel), args, status: 'pending', output: '', outputLineCount: 0,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLabel ? { toolLabel } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/** The row of a call known only from its result — a reload, or a result whose call was never announced. */
export function toolFromStep(id: string, step: ResearchStep, turnId?: string): ToolBlock {
  return settledTool(pendingTool(id, { ...step, turnId }), step);
}

/**
 * What a plan marker says, read from the transcript entry `PlannerConversation`
 * writes for it ("Plan generated with 2 tasks.", "Plan updated — now 1 task.").
 * That entry is the only record of the marker a reload has, so the live view
 * reads the same text rather than counting tasks itself.
 */
export function planMarker(content: string): { status: Exclude<PlanMarkerStatus, 'building'>; taskCount?: number } {
  const count = /(\d+) tasks?\b/.exec(content);
  return { status: content.startsWith('Plan updated') ? 'updated' : 'generated', ...(count ? { taskCount: Number(count[1]) } : {}) };
}

/** Whether any measure was reported: a token line of nothing but blanks says nothing. */
export function isMeasured(totals: UsageTotals): boolean {
  return totals.inputTokens !== undefined || totals.outputTokens !== undefined || totals.cachedInputTokens !== undefined
    || Object.keys(totals.reportedCost ?? {}).length > 0;
}
