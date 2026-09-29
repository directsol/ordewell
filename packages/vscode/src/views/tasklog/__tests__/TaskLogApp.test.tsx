import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import type { DisplayBlock } from '@ordewell/core';
import TaskLogApp from '../TaskLogApp';
import type { HostToTaskLog, TaskLogStatus } from '../../../shared/taskLogProtocol';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: HostToTaskLog): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

function status(overrides: Partial<TaskLogStatus> = {}): TaskLogStatus {
  return {
    taskId: 't1', order: 2, title: 'Parse JSON', runner: 'claude-code',
    planStatus: 'in_progress', awaitingApproval: 0, working: false, queued: [], attempts: [1], attempt: 1,
    ...overrides,
  };
}

const message = (id: string, text: string): DisplayBlock => ({ type: 'message', id, role: 'agent', text, streaming: false });

function init(overrides: Partial<TaskLogStatus> = {}, blocks: DisplayBlock[] = [message('b1', 'hello from the agent')]): void {
  send({ type: 'init', status: status(overrides), blocks });
}

describe('the task log tab (ADR-0018, V1)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  it('asks the host for the log when it mounts', () => {
    render(<TaskLogApp />);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('draws the saved blocks through the chat components', () => {
    render(<TaskLogApp />);
    init();

    expect(screen.getByText('Task 2 · Parse JSON')).toBeTruthy();
    expect(screen.getByText('hello from the agent')).toBeTruthy();
  });

  it('applies a live patch to the blocks it was sent', () => {
    render(<TaskLogApp />);
    init({}, [message('b1', 'first')]);
    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });

    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('shows the live state and sends a message on Send', () => {
    render(<TaskLogApp />);
    init({ working: true, awaitingReason: 'input' });
    expect(screen.getByText('Working')).toBeTruthy();

    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'use Postgres' } }); });
    act(() => { fireEvent.click(screen.getByText('Send')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'use Postgres' });
  });

  it('lists queued messages and takes one back', () => {
    render(<TaskLogApp />);
    init({ queued: [{ id: 'q1', text: 'then add tests' }] });

    expect(screen.getByText('then add tests')).toBeTruthy();
    act(() => { fireEvent.click(screen.getByTitle('Remove this message')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'q1' });
  });

  it('offers an interrupt only while a turn is live', () => {
    render(<TaskLogApp />);
    init({ working: false });
    expect(screen.queryByText('Interrupt')).toBeNull();

    send({ type: 'status', status: status({ working: true }) });
    act(() => { fireEvent.click(screen.getByText('Interrupt')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });
  });

  it('switches to an earlier attempt', () => {
    render(<TaskLogApp />);
    init({ attempts: [1, 2], attempt: 2 });

    act(() => { fireEvent.change(screen.getByLabelText('Attempt'), { target: { value: '1' } }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'selectAttempt', attempt: 1 });
  });

  it('shows a control refusal the host reported', () => {
    render(<TaskLogApp />);
    init();
    send({ type: 'showError', error: 'Task is not running.' });

    expect(screen.getByText('Task is not running.')).toBeTruthy();
  });

  describe('a runner\'s tool request (ADR-0018, A1)', () => {
    const request = (overrides: Partial<Extract<DisplayBlock, { type: 'approval' }>> = {}): DisplayBlock => ({
      type: 'approval', id: 'b2', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash', status: 'pending', allowForTask: true,
      ...overrides,
    });

    it('offers Allow, Allow for this task and Deny, each sent with its whole decision', () => {
      render(<TaskLogApp />);
      init({ working: true, awaitingApproval: 1 }, [request()]);
      expect(screen.getByText('Waiting for approval', { selector: '.task-log-state' })).toBeTruthy();

      fireEvent.click(screen.getByText('Allow'));
      fireEvent.click(screen.getByText('Allow for this task'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allow' } });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allowForTask' } });
    });

    it('denies with the note typed on the card', () => {
      render(<TaskLogApp />);
      init({}, [request()]);
      fireEvent.change(screen.getByPlaceholderText(/Note to the agent/), { target: { value: '  write it under notes/ ' } });
      fireEvent.click(screen.getByText('Deny'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'deny', note: 'write it under notes/' } });
    });

    it('leaves out Allow for this task when the runner offered no grant', () => {
      render(<TaskLogApp />);
      init({}, [request({ allowForTask: false })]);
      expect(screen.queryByText('Allow for this task')).toBeNull();
      expect(screen.getByText('Allow')).toBeTruthy();
    });

    it('settles into how it was answered, with no buttons left', () => {
      render(<TaskLogApp />);
      init({}, [
        request({ status: 'granted', decidedBy: 'asked', forTask: true }),
        request({ id: 'b3', approvalId: 'ap-2', status: 'denied', decidedBy: 'asked', note: 'use notes/' }),
        request({ id: 'b4', approvalId: 'ap-3', status: 'withdrawn' }),
      ]);
      expect(screen.getByText('Approved for this task')).toBeTruthy();
      expect(screen.getByText('Note to the agent: use notes/')).toBeTruthy();
      expect(screen.getByText('Withdrawn')).toBeTruthy();
      expect(screen.queryByText('Allow')).toBeNull();
    });
  });
});
