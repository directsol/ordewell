import React, { useState, useEffect, useMemo } from 'react';
import { ConversationBlocks } from '../chat/components/ChatMessage';
import { hasHiddenDetail } from '@ordewell/core/plan-utils';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type PatchedView } from '../../shared/conversationPatch';
import type { HostToTaskLog, TaskLogStatus, TaskLogToHost } from '../../shared/taskLogProtocol';
import { taskLogState } from './taskLogState';

declare function acquireVsCodeApi(): { postMessage(message: TaskLogToHost): void };

const vscode = acquireVsCodeApi();

function noop(): void {}

/**
 * One structured task's log (ADR-0018, V1), in its own editor tab. It draws
 * the same display blocks as the planner chat through the same components and
 * stylesheet, and adds what only a task has: a live-state header, a message
 * box, the queued messages, an interrupt, and an attempt switcher. The host
 * reduces the log and patches blocks in; nothing here knows the event format.
 */
export default function TaskLogApp() {
  const [view, setView] = useState<PatchedView>(EMPTY_PATCHED_VIEW);
  const [status, setStatus] = useState<TaskLogStatus | null>(null);
  const [detailAll, setDetailAll] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const blocks = useMemo(() => patchedBlocks(view), [view]);
  const state = status ? taskLogState(status) : null;
  const hasDetail = useMemo(() => hasHiddenDetail(blocks), [blocks]);
  const canSend = text.trim().length > 0;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToTaskLog>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          setView(applyConversationPatch(EMPTY_PATCHED_VIEW, {
            type: 'conversationPatch',
            order: msg.blocks.map((b) => b.id),
            changed: msg.blocks,
          }));
          setStatus(msg.status);
          setError('');
          break;
        case 'patch':
          setView((prev) => applyConversationPatch(prev, {
            type: 'conversationPatch',
            order: msg.order,
            changed: msg.changed,
          }));
          break;
        case 'status':
          setStatus(msg.status);
          break;
        case 'showError':
          setError(msg.error);
          break;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    vscode.postMessage({ type: 'sendTaskMessage', text: value });
    setText('');
  };

  const onComposerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  };

  return (
    <div className="task-log-container">
      {status && (
        <div className="task-log-header">
          <span className="task-log-title">Task {status.order} · {status.title}</span>
          {status.runner && <span className="task-log-runner">{status.runner}</span>}
          {state && <span className={`task-log-state ${state.kind}`}>{state.label}</span>}
          <span className="task-log-spacer" />
          {hasDetail && (
            <button type="button" className="task-log-detail" aria-pressed={detailAll}
              onClick={() => setDetailAll((v) => !v)} title="Show or hide the full thinking, command and subagent detail">
              {detailAll ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          {status.attempts.length > 1 && (
            <label className="task-log-attempt">
              Attempt
              <select value={status.attempt} onChange={(e) => vscode.postMessage({ type: 'selectAttempt', attempt: Number(e.target.value) })}>
                {status.attempts.map((attempt) => <option key={attempt} value={attempt}>{attempt}</option>)}
              </select>
            </label>
          )}
          {status.working && (
            <button type="button" className="task-log-interrupt" onClick={() => vscode.postMessage({ type: 'interruptTask' })}>
              Interrupt
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="task-log-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      <div className="task-log-body">
        {blocks.length === 0
          ? <div className="task-log-empty">{status?.working ? 'Working…' : 'No output yet.'}</div>
          : <ConversationBlocks blocks={blocks} detailAll={detailAll} onShowPlan={noop} />}
      </div>

      {status && status.queued.length > 0 && (
        <div className="task-log-queued">
          <div className="task-log-queued-title">Queued ({status.queued.length})</div>
          {status.queued.map((message) => (
            <div key={message.id} className="task-log-queued-item">
              <span className="task-log-queued-text">{message.text}</span>
              <button type="button" className="task-log-queued-remove" title="Remove this message"
                onClick={() => vscode.postMessage({ type: 'removeQueuedTaskMessage', id: message.id })}>&#10005;</button>
            </div>
          ))}
        </div>
      )}

      <div className="task-log-composer">
        <textarea className="task-log-input" value={text} rows={2}
          placeholder="Message the task… (Ctrl+Enter to send)"
          onChange={(e) => setText(e.target.value)} onKeyDown={onComposerKeyDown} />
        <button type="button" className="task-log-send" disabled={!canSend} onClick={send}>Send</button>
      </div>
    </div>
  );
}
