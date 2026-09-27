import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ResearchStep, SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge, post } from './hostBridge';

const TURN = 'turn-1';
const turnStarted = (prompt?: string): SessionMessage => ({ type: 'planner_turn_started', turnId: TURN, ...(prompt ? { prompt } : {}) });
const thought = (text: string): SessionMessage => ({ type: 'planner_thinking_delta', turnId: TURN, text });
const call: SessionMessage = { type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}', toolCallId: 'tc-1', turnId: TURN };
const done: SessionMessage = {
  type: 'research_step_done', turnId: TURN,
  step: { id: 's', tool: 'read_file', args: '{"path":"a.ts"}', result: 'a body', timestamp: '', success: true, outcome: 'success', toolCallId: 'tc-1' } as ResearchStep,
};

describe('expand-all control', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('lives in the chat header and flips every block both ways', () => {
    host.session(turnStarted('look around'), thought('Scanning…'), call, done);

    const toggle = () => document.querySelector('.chat-header .detail-toggle') as HTMLButtonElement;
    expect(toggle().textContent).toBe('Expand all');
    expect(document.querySelector('.activity-think-pre')).toBeNull();
    expect(document.querySelector('.cmd-row-output')).toBeNull();

    fireEvent.click(toggle());
    expect(toggle().textContent).toBe('Collapse all');
    expect(document.querySelector('.activity-think-pre')!.textContent).toBe('Scanning…');
    expect(document.querySelector('.cmd-row-output')!.textContent).toBe('a body');

    fireEvent.click(toggle());
    expect(toggle().textContent).toBe('Expand all');
    expect(document.querySelector('.activity-think-pre')).toBeNull();
    expect(document.querySelector('.cmd-row-output')).toBeNull();
  });

  it('stays out of the way when there is nothing to expand', () => {
    post({ type: 'setState', state: 'empty' });
    host.session(turnStarted('hi'), { type: 'planner_message', content: 'Hello.', timestamp: '', turnId: TURN });

    expect(document.querySelector('.chat-header .detail-toggle')).toBeNull();
  });
});
