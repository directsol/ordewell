import { describe, it, expect, vi } from 'vitest';
import { routePlannerStream, type PlannerStreamSink } from '../PlannerStreamRouter';
import type { SessionMessage } from '@ordewell/core';

function fakeSink(): PlannerStreamSink & { streamToken: ReturnType<typeof vi.fn>; sendResearchProgress: ReturnType<typeof vi.fn> } {
  return { streamToken: vi.fn(), sendResearchProgress: vi.fn() };
}

describe('routePlannerStream', () => {
  it('routes plan_token to the webview token stream', () => {
    const sink = fakeSink();
    const handled = routePlannerStream({ type: 'plan_token', token: 'Question: ' }, sink, true);
    expect(handled).toBe(true);
    expect(sink.streamToken).toHaveBeenCalledWith('Question: ');
    expect(sink.sendResearchProgress).not.toHaveBeenCalled();
  });

  // The webview draws streamed prose on the token stream until it adopts the
  // shared conversation view (#53).
  it('routes planner_text_delta to the webview token stream', () => {
    const sink = fakeSink();
    const handled = routePlannerStream({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Which ' }, sink, true);
    expect(handled).toBe(true);
    expect(sink.streamToken).toHaveBeenCalledWith('Which ');
  });

  it('drops a planner_text_delta that arrives after the turn was stopped', () => {
    const sink = fakeSink();
    expect(routePlannerStream({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'late' }, sink, false)).toBe(true);
    expect(sink.streamToken).not.toHaveBeenCalled();
  });

  // Streamed thinking keeps the thinking display it had as plan_thinking,
  // until the webview draws the shared view (#53).
  it('routes planner_thinking_delta to the webview thinking display', () => {
    const sink = fakeSink();
    expect(routePlannerStream({ type: 'planner_thinking_delta', turnId: 't1', segmentId: 's1', text: 'weighing it' }, sink, true)).toBe(true);
    expect(sink.sendResearchProgress).toHaveBeenCalledWith({ type: 'thinking', text: 'weighing it' });
  });

  it('keeps a subagent\'s thinking tagged with its subagent', () => {
    const sink = fakeSink();
    routePlannerStream({ type: 'plan_thinking', text: 'grep first', subagentId: 'sa1' }, sink, true);
    expect(sink.sendResearchProgress).toHaveBeenCalledWith({ type: 'thinking', text: 'grep first', subagentId: 'sa1' });
  });

  it('rebuilds the exact webview shapes for thinking, tool calls, and tool results', () => {
    const sink = fakeSink();
    const step = { id: 's1', tool: 'read_file' as const, args: '{"path":"x"}', result: 'ok', timestamp: '', success: true, outcome: 'success' as const };

    routePlannerStream({ type: 'plan_thinking', text: 'exploring' }, sink, true);
    routePlannerStream({ type: 'research_step', tool: 'read_file', args: '{"path":"x"}' }, sink, true);
    routePlannerStream({ type: 'research_step_done', step }, sink, true);

    expect(sink.sendResearchProgress.mock.calls).toEqual([
      [{ type: 'thinking', text: 'exploring' }],
      [{ type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"x"}' }],
      [{ type: 'tool_result', step }],
    ]);
  });

  it('threads subagentId through tool_call/tool_result for spawned research agents', () => {
    const sink = fakeSink();
    const step = { id: 's1', tool: 'read_file' as const, args: '{"path":"x"}', result: 'ok', timestamp: '', success: true, outcome: 'success' as const };

    routePlannerStream({ type: 'research_step', tool: 'read_file', args: '{"path":"x"}', subagentId: 'sub-1' }, sink, true);
    routePlannerStream({ type: 'research_step_done', step, subagentId: 'sub-1' }, sink, true);

    expect(sink.sendResearchProgress.mock.calls).toEqual([
      [{ type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"x"}', subagentId: 'sub-1' }],
      [{ type: 'tool_result', step, subagentId: 'sub-1' }],
    ]);
  });

  it('threads the tool_call id so a parallel same-tool round can be matched by identity', () => {
    const sink = fakeSink();
    const step = {
      id: 's1', tool: 'read_file' as const, args: '{"path":"b.ts"}', result: 'ok',
      timestamp: '', success: true, outcome: 'success' as const, toolCallId: 'tc-2',
    };

    routePlannerStream({ type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}', toolCallId: 'tc-1' }, sink, true);
    routePlannerStream({ type: 'research_step_done', step }, sink, true);

    expect(sink.sendResearchProgress.mock.calls).toEqual([
      [{ type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"a.ts"}', subagentId: undefined, toolCallId: 'tc-1' }],
      [{ type: 'tool_result', step, subagentId: undefined, toolCallId: 'tc-2' }],
    ]);
  });

  it('carries the outcome through untouched, so no surface re-derives it from the result text', () => {
    const sink = fakeSink();
    const step = {
      id: 's1', tool: 'bash' as const, args: '{"command":"rm -rf /"}', result: 'Command refused: …',
      timestamp: '', success: false, outcome: 'refused' as const,
    };

    routePlannerStream({ type: 'research_step_done', step }, sink, true);

    expect(sink.sendResearchProgress.mock.calls[0][0].step?.outcome).toBe('refused');
  });

  it('routes planner_liveness as a contentless research-progress ping', () => {
    const sink = fakeSink();
    const handled = routePlannerStream({ type: 'planner_liveness' }, sink, true);
    expect(handled).toBe(true);
    expect(sink.sendResearchProgress).toHaveBeenCalledWith({ type: 'liveness' });
  });

  it('leaves lifecycle messages to the caller', () => {
    const sink = fakeSink();
    const lifecycle: SessionMessage[] = [
      { type: 'planner_message', content: 'hi', timestamp: '' },
      { type: 'status_update', tasks: [] },
      { type: 'review_approved' },
      { type: 'execution_complete', summary: { total: 0, completed: 0, failed: 0 } },
    ];
    for (const msg of lifecycle) {
      expect(routePlannerStream(msg, sink, true)).toBe(false);
    }
    expect(sink.streamToken).not.toHaveBeenCalled();
    expect(sink.sendResearchProgress).not.toHaveBeenCalled();
  });

  it('claims but drops streaming variants once the planner turn was stopped', () => {
    const sink = fakeSink();
    expect(routePlannerStream({ type: 'plan_token', token: 'late' }, sink, false)).toBe(true);
    expect(routePlannerStream({ type: 'plan_thinking', text: 'late' }, sink, false)).toBe(true);
    expect(sink.streamToken).not.toHaveBeenCalled();
    expect(sink.sendResearchProgress).not.toHaveBeenCalled();
  });
});
