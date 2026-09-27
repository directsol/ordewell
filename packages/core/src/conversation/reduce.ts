import type { ResearchStep } from '../models/Task';
import type { SessionMessage } from '../services/SessionMessage';
import type { DisplayBlock, MessageBlock, PlanBlock, SubagentBlock, SubagentChild, SubagentStatus, ToolBlock, UsageBlock } from './blocks';
import { isMeasured, pendingTool, planMarker, settledTool, toolFromStep } from './records';

/**
 * A line a surface adds to the conversation itself rather than receiving from
 * the session: the user's prompt as it is sent, a notice, an error.
 */
export interface LocalEntry {
  type: 'local_entry';
  role: 'user' | 'system' | 'error';
  text: string;
}

export type ConversationInput = SessionMessage | LocalEntry;

export interface ConversationView {
  readonly blocks: readonly DisplayBlock[];
  readonly nextId: number;
  /**
   * The newest transcript entry the view accounts for. Plan markers and system
   * notes reach a surface only inside the transcript a `plan_generated`
   * carries, so entries after this one are what is new in it.
   */
  readonly transcriptAt?: string;
}

export const EMPTY_CONVERSATION: ConversationView = { blocks: [], nextId: 1 };

type Message<T extends SessionMessage['type']> = Extract<SessionMessage, { type: T }>;

/** The top level of the conversation (`null`), or the index of the subagent whose children are meant. */
type Lane = number | null;

function findLastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return i;
  return -1;
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = items.slice();
  next[index] = item;
  return next;
}

// The usage line always sits last, so everything else lands above it.
function insertTop(blocks: readonly DisplayBlock[], block: DisplayBlock): DisplayBlock[] {
  const last = blocks[blocks.length - 1];
  return last?.type === 'usage' ? [...blocks.slice(0, -1), block, last] : [...blocks, block];
}

function append(view: ConversationView, make: (id: string) => DisplayBlock): ConversationView {
  return { ...view, blocks: insertTop(view.blocks, make(`b${view.nextId}`)), nextId: view.nextId + 1 };
}

function subagentAt(view: ConversationView, lane: number): SubagentBlock {
  const block = view.blocks[lane];
  if (block.type !== 'subagent') throw new Error(`block ${lane} is not a subagent`);
  return block;
}

function laneBlocks(view: ConversationView, lane: Lane): readonly DisplayBlock[] {
  return lane === null ? view.blocks : subagentAt(view, lane).children;
}

function setChildren(view: ConversationView, lane: number, children: readonly SubagentChild[]): ConversationView {
  return { ...view, blocks: replaceAt(view.blocks, lane, { ...subagentAt(view, lane), children }) };
}

function laneReplace(view: ConversationView, lane: Lane, index: number, block: SubagentChild): ConversationView {
  if (lane === null) return { ...view, blocks: replaceAt(view.blocks, index, block) };
  return setChildren(view, lane, replaceAt(subagentAt(view, lane).children, index, block));
}

function laneAppend(view: ConversationView, lane: Lane, make: (id: string) => SubagentChild): ConversationView {
  if (lane === null) return append(view, make);
  const children = [...subagentAt(view, lane).children, make(`b${view.nextId}`)];
  return { ...setChildren(view, lane, children), nextId: view.nextId + 1 };
}

function isStreaming(block: DisplayBlock): boolean {
  return (block.type === 'message' || block.type === 'thinking') && block.streaming;
}

function sealed<B extends DisplayBlock>(block: B): B {
  return isStreaming(block) ? { ...block, streaming: false } : block;
}

/**
 * Planner output landed at `keep` in the lane, so nothing else there is still
 * streaming: one lane has one voice at a time, and a block left marked as
 * streaming would keep its cursor after its text had moved on.
 */
function sealLane(view: ConversationView, lane: Lane, keep: number): ConversationView {
  const blocks = laneBlocks(view, lane);
  if (!blocks.some((b, i) => i !== keep && isStreaming(b))) return view;
  if (lane === null) return { ...view, blocks: view.blocks.map((b, i) => (i === keep ? b : sealed(b))) };
  return setChildren(view, lane, subagentAt(view, lane).children.map((b, i) => (i === keep ? b : sealed(b))));
}

/** Append planner output to the lane, which then speaks through it alone. */
function appendOutput(view: ConversationView, lane: Lane, make: (id: string) => SubagentChild): ConversationView {
  const next = laneAppend(view, lane, make);
  return sealLane(next, lane, findLastIndex(laneBlocks(next, lane), (b) => b.type !== 'usage'));
}

function isUnsettledSegment(block: DisplayBlock, turnId: string): block is MessageBlock {
  return block.type === 'message' && block.turnId === turnId && block.segmentId !== undefined;
}

function isBuildingPlan(block: DisplayBlock, turnId: string | undefined): block is PlanBlock {
  return block.type === 'plan' && block.status === 'building' && block.turnId === turnId;
}

/**
 * Where the turn's final segment is, if its text streamed: the turn's latest
 * block, when that is streamed text. Anything the turn did after a segment —
 * a tool call, a plan envelope — means a later segment follows it, and a later
 * segment never rewrites an earlier one. `pastPlan` looks past the turn's plan
 * block, for a plan that settled after its own text.
 */
function finalSegmentIndex(blocks: readonly DisplayBlock[], turnId: string, pastPlan = false): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'usage' || block.type === 'thinking' || block.type === 'approval' || (pastPlan && block.type === 'plan')) continue;
    if (block.turnId !== turnId) continue;
    return isUnsettledSegment(block, turnId) ? i : -1;
  }
  return -1;
}

function openTurn(view: ConversationView, turnId: string, prompt: string): ConversationView {
  // A surface shows its user's prompt the moment it is sent; the turn that
  // answers it adopts that line rather than repeating it.
  const i = findLastIndex(view.blocks, (b) => b.type === 'message' && b.role === 'user');
  const sent = view.blocks[i];
  if (sent?.type === 'message' && sent.turnId === undefined && sent.text === prompt) {
    return { ...view, blocks: replaceAt(view.blocks, i, { ...sent, turnId }) };
  }
  return append(view, (id) => ({ type: 'message', id, role: 'user', text: prompt, streaming: false, turnId }));
}

function streamText(view: ConversationView, { turnId, segmentId, text }: Message<'planner_text_delta'>): ConversationView {
  const i = findLastIndex(view.blocks, (b) => isUnsettledSegment(b, turnId) && b.segmentId === segmentId);
  const segment = view.blocks[i];
  if (segment?.type === 'message') {
    return sealLane(laneReplace(view, null, i, { ...segment, text: segment.text + text, streaming: true }), null, i);
  }
  return appendOutput(view, null, (id) => ({ type: 'message', id, role: 'planner', text, streaming: true, turnId, segmentId }));
}

/**
 * Drop the turn's plan display while it is still building: whatever streamed
 * there did not become a plan — a task-ops or task-query envelope, or, from a
 * daemon older than turns, the reply's prose.
 */
function dropBuildingPlan(view: ConversationView, turnId: string | undefined, segmentId?: string): ConversationView {
  const blocks = view.blocks.filter((b) => !(isBuildingPlan(b, turnId) && (segmentId === undefined || b.segmentId === segmentId)));
  return blocks.length === view.blocks.length ? view : { ...view, blocks };
}

function settleReply(view: ConversationView, { content, turnId }: Message<'planner_message'>): ConversationView {
  if (turnId !== undefined) {
    const i = finalSegmentIndex(view.blocks, turnId);
    if (i >= 0) {
      const settled: MessageBlock = { type: 'message', id: view.blocks[i].id, role: 'planner', text: content, streaming: false, turnId };
      return dropBuildingPlan({ ...view, blocks: replaceAt(view.blocks, i, settled) }, turnId);
    }
  }
  return append(dropBuildingPlan(view, turnId), (id) => ({ type: 'message', id, role: 'planner', text: content, streaming: false, ...(turnId ? { turnId } : {}) }));
}

// A retracted envelope takes the turn's plan display with it, or its retry
// would build on the botched JSON and the partial-plan rows read both.
function retractText(view: ConversationView, { turnId, segmentId }: Message<'planner_text_retracted'>): ConversationView {
  const blocks = view.blocks.filter((b) => !(isUnsettledSegment(b, turnId) && (segmentId === undefined || b.segmentId === segmentId)));
  return dropBuildingPlan(blocks.length === view.blocks.length ? view : { ...view, blocks }, turnId, segmentId);
}

/**
 * The subagent's block, created on first sighting: its activity can arrive
 * before (or without) its start. The planner call that spawns it becomes the
 * block, keeping the call's id and position — the call and the subagent are
 * one thing on screen.
 */
function subagentLane(view: ConversationView, subagentId: string, turnId?: string): [ConversationView, number] {
  const existing = findLastIndex(view.blocks, (b) => b.type === 'subagent' && b.subagentId === subagentId);
  if (existing >= 0) return [view, existing];
  const spawn = findLastIndex(view.blocks, (b) => b.type === 'tool' && (b.spawns === subagentId || b.toolCallId === subagentId));
  const call = view.blocks[spawn];
  if (call?.type === 'tool') {
    const block: SubagentBlock = {
      type: 'subagent', id: call.id, subagentId, brief: call.headline.keyArg, status: 'running', children: [], digest: '',
      ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
      ...(call.turnId ? { turnId: call.turnId } : {}),
    };
    return [{ ...view, blocks: replaceAt(view.blocks, spawn, block) }, spawn];
  }
  const next = append(view, (id) => ({ type: 'subagent', id, subagentId, brief: '', status: 'running', children: [], digest: '', ...(turnId ? { turnId } : {}) }));
  return [next, findLastIndex(next.blocks, (b) => b.type === 'subagent' && b.subagentId === subagentId)];
}

function updateSubagent(view: ConversationView, subagentId: string, turnId: string | undefined, update: (block: SubagentBlock) => SubagentBlock): ConversationView {
  const [next, lane] = subagentLane(view, subagentId, turnId);
  return { ...next, blocks: replaceAt(next.blocks, lane, update(subagentAt(next, lane))) };
}

function startSubagent(view: ConversationView, { subagentId, brief, model, turnId }: Message<'subagent_started'>): ConversationView {
  return updateSubagent(view, subagentId, turnId, (block) => ({ ...block, ...(brief ? { brief } : {}), ...(model ? { model } : {}) }));
}

function finishSubagent(view: ConversationView, { subagentId, outcome, digest, usage, turnId }: Message<'subagent_finished'>): ConversationView {
  return updateSubagent(view, subagentId, turnId, (block) => ({
    ...block, status: outcome, digest, children: block.children.map(sealed), ...(usage ? { usage } : {}),
  }));
}

function think(view: ConversationView, text: string, turnId?: string, segmentId?: string, subagentId?: string): ConversationView {
  const [placed, lane]: [ConversationView, Lane] = subagentId ? subagentLane(view, subagentId, turnId) : [view, null];
  const blocks = laneBlocks(placed, lane);
  const lastIndex = findLastIndex(blocks, (b) => b.type !== 'usage');
  const last = blocks[lastIndex];
  if (last?.type === 'thinking' && last.streaming && last.segmentId === segmentId) {
    return laneReplace(placed, lane, lastIndex, { ...last, text: last.text + text });
  }
  return appendOutput(placed, lane, (id) => ({
    type: 'thinking', id, text, streaming: true,
    ...(turnId ? { turnId } : {}),
    ...(segmentId ? { segmentId } : {}),
    ...(subagentId ? { subagentId } : {}),
  }));
}

function announceTool(view: ConversationView, call: Message<'research_step'>): ConversationView {
  // A spawn call names the subagent it starts; any other call tagged with a
  // subagent is that subagent's own.
  const spawns = call.tool === 'spawn_research_agent' ? call.subagentId : undefined;
  const [placed, lane]: [ConversationView, Lane] = call.subagentId && !spawns ? subagentLane(view, call.subagentId, call.turnId) : [view, null];
  return appendOutput(placed, lane, (id) => ({ ...pendingTool(id, call), ...(spawns ? { spawns } : {}) }));
}

// By the call's id: results of a parallel round return in any order, and a
// name match would put one call's output on another's row (ADR-0008). The
// name scan survives only for calls that announced no id.
function isPendingCallOf(block: DisplayBlock, step: ResearchStep): block is ToolBlock {
  if (block.type !== 'tool' || block.status !== 'pending') return false;
  return step.toolCallId ? block.toolCallId === step.toolCallId : block.toolCallId === undefined && block.tool === step.tool;
}

function settleTool(view: ConversationView, { step, turnId }: Message<'research_step_done'>): ConversationView {
  const [placed, lane]: [ConversationView, Lane] = step.subagentId ? subagentLane(view, step.subagentId, turnId) : [view, null];
  const blocks = laneBlocks(placed, lane);
  const i = findLastIndex(blocks, (b) => isPendingCallOf(b, step));
  const pending = blocks[i];
  if (pending?.type === 'tool') return laneReplace(placed, lane, i, settledTool(pending, step));
  // The call that spawned a subagent is shown by the subagent's block, and
  // only the subagent's own finish settles it: a backgrounded agent's call
  // returns at launch, long before the work ends.
  if (lane === null && step.toolCallId && blocks.some((b) => b.type === 'subagent' && b.toolCallId === step.toolCallId)) return view;
  return laneAppend(placed, lane, (id) => toolFromStep(id, step, turnId));
}

/**
 * The building display shows one envelope: the segment streaming now. A turn's
 * later envelope (a plan after a read it asked for) starts it over, below
 * whatever the turn did in between, rather than running on from the last one.
 */
function streamPlan(view: ConversationView, { token, turnId, segmentId }: Message<'plan_token'>): ConversationView {
  const i = findLastIndex(view.blocks, (b) => isBuildingPlan(b, turnId));
  const building = view.blocks[i];
  if (building?.type === 'plan' && building.segmentId === segmentId) {
    return { ...view, blocks: replaceAt(view.blocks, i, { ...building, text: building.text + token }) };
  }
  return append(dropBuildingPlan(view, turnId), (id) => ({
    type: 'plan', id, status: 'building', text: token, ...(turnId ? { turnId } : {}), ...(segmentId ? { segmentId } : {}),
  }));
}

/** A plan landed: the building display of the turn that committed it becomes its marker. */
function markPlan(view: ConversationView, content: string, turnId: string | undefined): ConversationView {
  const marker = planMarker(content);
  const i = findLastIndex(view.blocks, (b) => isBuildingPlan(b, turnId));
  const building = view.blocks[i];
  if (building?.type === 'plan') {
    const settled: PlanBlock = { type: 'plan', id: building.id, ...marker, text: '', ...(building.turnId ? { turnId: building.turnId } : {}) };
    return { ...view, blocks: replaceAt(view.blocks, i, settled) };
  }
  return append(view, (id) => ({ type: 'plan', id, text: '', ...marker }));
}

function requestApproval(view: ConversationView, { id: approvalId, kind, subject, scope, detail, turnId }: Message<'approval_request'>): ConversationView {
  return append(view, (id) => ({
    type: 'approval', id, approvalId, kind, subject, scope, status: 'pending',
    ...(detail ? { detail } : {}),
    ...(turnId ? { turnId } : {}),
  }));
}

function settleApproval(view: ConversationView, { id, granted }: Message<'approval_settled'>): ConversationView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'approval' && b.approvalId === id);
  const request = view.blocks[i];
  if (request?.type !== 'approval') return view;
  return { ...view, blocks: replaceAt(view.blocks, i, { ...request, status: granted ? 'granted' : 'denied', decidedBy: 'asked' }) };
}

function decideApproval(view: ConversationView, { kind, subject, scope, detail, granted, source }: Message<'approval_decided'>): ConversationView {
  return append(view, (id) => ({
    type: 'approval', id, kind, subject, scope, status: granted ? 'granted' : 'denied', decidedBy: source,
    ...(detail ? { detail } : {}),
  }));
}

function reportUsage(view: ConversationView, { totals, bySubagent, contextFill }: Message<'planner_usage'>): ConversationView {
  if (!isMeasured(totals)) return view;
  const last = view.blocks[view.blocks.length - 1];
  const id = last?.type === 'usage' ? last.id : `b${view.nextId}`;
  const line: UsageBlock = { type: 'usage', id, totals, ...(bySubagent ? { bySubagent } : {}), ...(contextFill ? { contextFill } : {}) };
  if (last?.type === 'usage') return { ...view, blocks: replaceAt(view.blocks, view.blocks.length - 1, line) };
  return { ...view, blocks: [...view.blocks, line], nextId: view.nextId + 1 };
}

function closeBlock<B extends DisplayBlock>(block: B, interrupted: boolean): B {
  return interrupted && block.type === 'tool' && block.status === 'pending' ? { ...block, status: 'interrupted' } : sealed(block);
}

function closeSubagent(block: SubagentBlock, cut: SubagentStatus | null): SubagentBlock {
  const children = block.children.map((c) => closeBlock(c, cut !== null));
  const status = cut && block.status === 'running' ? cut : block.status;
  return status === block.status && children.every((c, i) => c === block.children[i]) ? block : { ...block, status, children };
}

/**
 * Nothing carries the turn's id after this, so whatever it left open is closed:
 * streaming stops, and on a stop or failure its unanswered calls and running
 * subagents say they were cut short. A plan reply that streamed as text (a
 * prose preamble decides a segment's route) gives way to its plan block, as a
 * settled message would have replaced it.
 */
function endTurn(view: ConversationView, { turnId, outcome }: Message<'planner_turn_ended'>): ConversationView {
  let next = dropBuildingPlan(view, turnId);
  const planText = outcome === 'plan' ? finalSegmentIndex(next.blocks, turnId, true) : -1;
  if (planText >= 0) next = { ...next, blocks: next.blocks.filter((_, i) => i !== planText) };
  const cut: SubagentStatus | null = outcome === 'stopped' ? 'stopped' : outcome === 'error' ? 'failed' : null;
  const blocks = next.blocks.map((b) => (b.type === 'subagent' ? closeSubagent(b, cut) : closeBlock(b, cut !== null)));
  return blocks.every((b, i) => b === next.blocks[i]) ? next : { ...next, blocks };
}

// The summary is announced as a planner message before the transcript it now
// heads arrives; the transcript records it as a notice, and so does the view.
function markCompaction(view: ConversationView, summary: string): ConversationView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'message' && b.role === 'planner' && b.turnId === undefined && b.text === summary);
  const announced = view.blocks[i];
  if (announced?.type === 'message') return { ...view, blocks: replaceAt(view.blocks, i, { ...announced, role: 'system' }) };
  return append(view, (id) => ({ type: 'message', id, role: 'system', text: summary, streaming: false }));
}

function syncTranscript(view: ConversationView, { plan, turnId }: Message<'plan_generated'>): ConversationView {
  const history = plan.conversationHistory ?? [];
  // Only the newest marker can be the committing turn's; older ones a surface
  // is only now catching up on belong to turns long over.
  const committed = findLastIndex(history, (e) => e.kind === 'plan_generated');
  let next = view;
  let latest = view.transcriptAt;
  for (const [i, entry] of history.entries()) {
    const isNew = view.transcriptAt === undefined || entry.timestamp > view.transcriptAt;
    if (isNew && entry.kind === 'plan_generated') next = markPlan(next, entry.content, i === committed ? turnId : undefined);
    if (isNew && entry.kind === 'system') next = append(next, (id) => ({ type: 'message', id, role: 'system', text: entry.content, streaming: false }));
    if (isNew && entry.kind === 'compaction') next = markCompaction(next, entry.content);
    if (latest === undefined || entry.timestamp > latest) latest = entry.timestamp;
  }
  return next === view && latest === view.transcriptAt ? view : { ...next, transcriptAt: latest };
}

/**
 * Fold one input into the view. Pure and incremental: blocks the input does
 * not touch keep their identity, and an input that changes nothing returns
 * `view` itself — surfaces memoize their drawing on that, and text deltas
 * arrive quickly.
 */
export function reduceConversation(view: ConversationView, input: ConversationInput): ConversationView {
  switch (input.type) {
    case 'local_entry':
      return append(view, (id) => ({ type: 'message', id, role: input.role, text: input.text, streaming: false }));
    case 'planner_turn_started':
      return input.prompt === undefined ? view : openTurn(view, input.turnId, input.prompt);
    case 'planner_text_delta':
      return streamText(view, input);
    case 'planner_message':
      return settleReply(view, input);
    case 'planner_text_retracted':
      return retractText(view, input);
    case 'planner_thinking_delta':
      return think(view, input.text, input.turnId, input.segmentId, input.subagentId);
    case 'research_step':
      return announceTool(view, input);
    case 'research_step_done':
      return settleTool(view, input);
    case 'subagent_started':
      return startSubagent(view, input);
    case 'subagent_finished':
      return finishSubagent(view, input);
    case 'plan_token':
      return streamPlan(view, input);
    case 'plan_generated':
      return syncTranscript(view, input);
    case 'planner_turn_ended':
      return endTurn(view, input);
    case 'approval_request':
      return requestApproval(view, input);
    case 'approval_settled':
      return settleApproval(view, input);
    case 'approval_decided':
      return decideApproval(view, input);
    case 'planner_usage':
      return reportUsage(view, input);
    default:
      return view;
  }
}
