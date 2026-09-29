import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask, type Task, type TaskLogEvent } from '@ordewell/core';
import { TaskLogRegistry } from '../providers/TaskLogRegistry';
import type { HostToTaskLog } from '../shared/taskLogProtocol';
import { __panels, __resetPanels } from '../test/vscode.mock';

const createWebviewPanel = vscode.window.createWebviewPanel as unknown as ReturnType<typeof vi.fn>;

const attemptOne: TaskLogEvent[] = [
  { type: 'turn_start', message: 'do it' },
  { type: 'text', text: 'working…' },
  { type: 'turn_end', reason: 'completed' },
];
const attemptTwo: TaskLogEvent[] = [
  { type: 'turn_start', message: 'again' },
  { type: 'text', text: 'second try' },
];

function harness(attempts: Record<number, TaskLogEvent[]> = { 1: attemptOne }) {
  const task = createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code', status: 'in_progress' });
  const session = {
    taskLogAttempts: vi.fn(() => Object.keys(attempts).map(Number).sort((a, b) => a - b)),
    taskLog: vi.fn((_taskId: string, attempt: number) => attempts[attempt] ?? []),
    sendTaskMessage: vi.fn(() => 'm1'),
    removeQueuedTaskMessage: vi.fn(() => true),
    interruptTask: vi.fn(async () => {}),
    continueTask: vi.fn(async () => {}),
  };
  const registry = new TaskLogRegistry({
    extensionUri: vscode.Uri.file('/ext'),
    session: () => session,
    getTask: () => task as Task,
    log: vi.fn(),
  });
  return { registry, session, task };
}

/** The messages one panel's webview has been sent, oldest first. */
function posted(panel: (typeof __panels)[number]): HostToTaskLog[] {
  return panel.webview.postMessage.mock.calls.map((call) => call[0] as HostToTaskLog);
}

describe('the task-log registry (ADR-0018, V1)', () => {
  beforeEach(() => {
    __resetPanels();
    createWebviewPanel.mockClear();
  });

  it('never opens a tab by itself, and opens one titled for the task on demand', () => {
    const h = harness();
    expect(createWebviewPanel).not.toHaveBeenCalled();

    h.registry.open('t1');

    expect(createWebviewPanel).toHaveBeenCalledWith('ordewellTaskLog', 'Task 1 · Parse JSON', vscode.ViewColumn.Active, expect.anything());
    expect(__panels).toHaveLength(1);
  });

  it('focuses the open tab instead of opening a second', () => {
    const h = harness();
    h.registry.open('t1');
    h.registry.open('t1');

    expect(__panels).toHaveLength(1);
    expect(__panels[0].reveal).toHaveBeenCalled();
  });

  it('does nothing for a task that is not in the plan', () => {
    const registry = new TaskLogRegistry({
      extensionUri: vscode.Uri.file('/ext'),
      session: () => ({ taskLogAttempts: () => [], taskLog: () => [], sendTaskMessage: () => 'm', removeQueuedTaskMessage: () => false, interruptTask: async () => {}, continueTask: async () => {} }),
      getTask: () => undefined,
      log: vi.fn(),
    });

    registry.open('missing');

    expect(createWebviewPanel).not.toHaveBeenCalled();
  });

  it('loads the newest saved attempt when the webview is ready', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    const init = posted(__panels[0])[0];
    expect(init).toMatchObject({ type: 'init', status: { attempts: [1, 2], attempt: 2, title: 'Parse JSON', runner: 'claude-code' } });
    expect(init.type === 'init' && init.blocks.map((b) => b.type)).toEqual(['message', 'message']);
    expect(h.session.taskLog).toHaveBeenCalledWith('t1', 2);
  });

  it('folds a live batch in as a patch, and follows a new attempt', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: ' more' }] });
    expect(posted(__panels[0]).some((m) => m.type === 'patch')).toBe(true);

    // A retry's new attempt is followed while the user is on the live one.
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 2, events: [{ type: 'turn_start', message: 'again' }] });
    const last = posted(__panels[0]).at(-1);
    expect(last).toMatchObject({ type: 'init', status: { attempt: 2 } });
  });

  it('switches to an earlier attempt on request', () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });

    expect(h.session.taskLog).toHaveBeenCalledWith('t1', 1);
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { attempt: 1 } });
  });

  it('routes a message, a removal and an interrupt to the Session', async () => {
    const h = harness();
    h.registry.open('t1');

    __panels[0].__receive({ type: 'sendTaskMessage', text: 'use Postgres' });
    __panels[0].__receive({ type: 'removeQueuedTaskMessage', id: 'q1' });
    __panels[0].__receive({ type: 'interruptTask' });

    expect(h.session.sendTaskMessage).toHaveBeenCalledWith('t1', 'use Postgres');
    expect(h.session.removeQueuedTaskMessage).toHaveBeenCalledWith('t1', 'q1');
    await vi.waitFor(() => expect(h.session.interruptTask).toHaveBeenCalledWith('t1'));
  });

  it('shows the Session\u2019s refusal of a task that cannot take a message', () => {
    const h = harness();
    h.session.sendTaskMessage.mockImplementation(() => { throw new Error('Task is not running.'); });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    __panels[0].__receive({ type: 'sendTaskMessage', text: 'hello' });

    expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task is not running.' });
  });

  it('closing the tab never touches the task, and reopening loads it afresh', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__fireDispose();

    expect(h.session.sendTaskMessage).not.toHaveBeenCalled();
    expect(h.session.interruptTask).not.toHaveBeenCalled();

    h.registry.open('t1');
    expect(__panels).toHaveLength(2);
  });

  it('refreshes the header from the task when the plan changes', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].webview.postMessage.mockClear();

    h.task.status = 'awaiting_user';
    h.task.awaitingReason = 'input';
    h.registry.receive({ type: 'status_update', tasks: [] });

    const status = posted(__panels[0]).find((m) => m.type === 'status');
    expect(status).toMatchObject({ type: 'status', status: { planStatus: 'awaiting_user', awaitingReason: 'input' } });
  });

  it('offers Continue only for a finished structured task with a saved session (ADR-0018, K1)', () => {
    const h = harness();
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    expect(posted(__panels[0])[0]).toMatchObject({ type: 'init', status: { continuable: false } });
    __panels[0].webview.postMessage.mockClear();

    h.task.status = 'completed';
    h.task.transport = { kind: 'structured', nativeSessionId: 'sess-1' };
    h.registry.receive({ type: 'status_update', tasks: [] });

    expect(posted(__panels[0]).find((m) => m.type === 'status')).toMatchObject({ status: { continuable: true } });
  });

  it('continues the task through the Session and follows the new attempt, even from an earlier one', async () => {
    const h = harness({ 1: attemptOne, 2: attemptTwo });
    h.task.status = 'completed';
    h.task.transport = { kind: 'structured', nativeSessionId: 'sess-1' };
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });
    __panels[0].__receive({ type: 'selectAttempt', attempt: 1 });

    __panels[0].__receive({ type: 'continueTask', text: 'also handle arrays' });
    await vi.waitFor(() => expect(h.session.continueTask).toHaveBeenCalledWith('t1', 'also handle arrays'));

    __panels[0].webview.postMessage.mockClear();
    h.registry.receive({ type: 'task_log', taskId: 't1', attempt: 3, events: [{ type: 'turn_start', message: 'also handle arrays' }] });
    expect(posted(__panels[0]).at(-1)).toMatchObject({ type: 'init', status: { attempt: 3, attempts: [1, 2, 3] } });
  });

  it('shows the Session’s refusal of a continue', async () => {
    const h = harness();
    h.session.continueTask.mockImplementation(async () => { throw new Error('Task "Parse JSON" cannot be continued: it ran in a terminal.'); });
    h.registry.open('t1');
    __panels[0].__receive({ type: 'ready' });

    __panels[0].__receive({ type: 'continueTask', text: 'more' });

    await vi.waitFor(() => expect(posted(__panels[0])).toContainEqual({ type: 'showError', error: 'Task "Parse JSON" cannot be continued: it ran in a terminal.' }));
  });
});
