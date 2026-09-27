import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge } from './hostBridge';

const TURN = 'turn-1';
const turnStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN };
const usage = (over: Partial<Extract<SessionMessage, { type: 'planner_usage' }>>): SessionMessage => ({
  type: 'planner_usage', turnId: TURN, totals: { inputTokens: 1_234, outputTokens: 567 }, ...over,
});

describe('token line', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('sits outside the scrolling conversation and names tokens in and out', () => {
    host.session(turnStarted, usage({}));

    const line = document.querySelector('.usage-line')!;
    expect(line).toBeTruthy();
    expect(line.textContent).toContain('1,234 in');
    expect(line.textContent).toContain('567 out');
    expect(document.querySelector('.message-list')!.contains(line)).toBe(false);
  });

  it('omits cost when nothing reported one, and the context fill when unknown', () => {
    host.session(turnStarted, usage({}));

    const line = document.querySelector('.usage-line')!;
    expect(line.textContent).not.toContain('$');
    expect(line.textContent).not.toContain('context');
  });

  it('shows the context fill when the runner reported a window', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 700, windowTokens: 10_000 } }));

    const line = document.querySelector('.usage-line')!;
    expect(line.textContent).toContain('context 7%');
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('700 / 10,000 tokens');
  });

  it('shows cost only when reported', () => {
    host.session(turnStarted, usage({ totals: { inputTokens: 1_234, outputTokens: 567, reportedCost: { usd: 0.0123 } } }));

    expect(document.querySelector('.usage-line')!.textContent).toContain('$0.0123');
  });

  it('includes subagent usage in the totals, with its own share on hover', () => {
    host.session(turnStarted, usage({
      totals: { inputTokens: 500, outputTokens: 100 },
      bySubagent: { 'sub-1': { inputTokens: 200, outputTokens: 40 } },
    }));

    const line = document.querySelector('.usage-line')!;
    expect(line.textContent).toContain('500 in');
    expect(line.textContent).toContain('100 out');
    const agents = document.querySelector('.usage-line-subagents')!;
    expect(agents.textContent).toContain('1 subagent');
    expect(agents.getAttribute('title')).toContain('sub-1');
    expect(agents.getAttribute('title')).toContain('200 in');
    expect(agents.getAttribute('title')).toContain('40 out');
  });
});
