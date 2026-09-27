import React from 'react';
import type {
  ApprovalBlock, ApprovalKind, ApprovalSource, DisplayBlock, MessageBlock, PlanBlock, SubagentBlock, SubagentStatus,
  ThinkingDisplayBlock, ToolBlock, ToolStatus,
} from '@ordewell/core';
import { outputLines, outputPreview } from '@ordewell/core/plan-utils';

/*
 * The planner conversation (#51 display blocks) as the webview draws it.
 * Whether thinking, command and subagent blocks show their detail is one
 * switch for the whole conversation, like the TUI's ctrl+o — so no block here
 * opens on its own.
 */

const PREVIEW_LINES = 3;

export function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export default function ChatMessage({ block }: { block: MessageBlock }) {
  if (block.role === 'system' || block.role === 'error') {
    return (
      <div className={`chat-msg chat-msg-${block.role}`}>
        <span className="chat-msg-content">{block.text}</span>
      </div>
    );
  }
  if (block.role === 'user') {
    return (
      <div className="chat-msg chat-msg-user">
        <div className="chat-msg-bubble">
          <div className="chat-msg-content">{block.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`chat-msg chat-msg-planner${block.streaming ? ' streaming' : ''}`}>
      <div className="chat-msg-bubble">
        <div className="chat-msg-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text.trim()) }} />
        {block.streaming && <span className="chat-msg-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}

export function ThinkingBlock({ block, expanded }: { block: ThinkingDisplayBlock; expanded: boolean }) {
  const text = block.text.trim();
  return (
    <div className={`activity-think${expanded ? ' expanded' : ''}`}>
      <div className="activity-think-head">
        <span className="activity-think-label">Thinking{block.streaming ? '…' : ''}</span>
        {!expanded && <span className="activity-think-line">{text.split('\n')[0]}</span>}
      </div>
      {expanded && <pre className="activity-think-pre">{text}</pre>}
    </div>
  );
}

const STATUS_ICON: Record<ToolStatus, string> = {
  pending: '⚙',
  ok: '✓',
  error: '✗',
  denied: '⊘',
  interrupted: '–',
};

// `status` alone reads a refused command and a denied path the same way; the
// finer outcome says which.
function outcomeLabel(block: ToolBlock): string {
  if (block.outcome && block.outcome !== 'success') return block.outcome === 'not_executed' ? 'not executed' : block.outcome;
  return block.status === 'interrupted' ? 'interrupted' : '';
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export function CommandRow({ block, expanded }: { block: ToolBlock; expanded: boolean }) {
  const label = outcomeLabel(block);
  const preview = outputPreview(block.output, PREVIEW_LINES);
  return (
    <div className={`cmd-row${expanded ? ' expanded' : ''}`} data-status={block.status}>
      <div className="cmd-row-header">
        <span className="cmd-row-icon">{STATUS_ICON[block.status]}</span>
        <code className="cmd-row-head">{block.headline.name}({block.headline.keyArg})</code>
        {label && <span className="cmd-row-outcome">{label}</span>}
      </div>
      {expanded ? (
        <>
          <pre className="cmd-row-args">{prettyArgs(block.args)}</pre>
          {block.output && <pre className="cmd-row-output">{outputLines(block.output).join('\n')}</pre>}
        </>
      ) : preview.lines.length > 0 && (
        <>
          <pre className="cmd-row-preview">{preview.lines.join('\n')}</pre>
          {preview.hiddenLineCount > 0 && (
            <span className="cmd-row-more">+{preview.hiddenLineCount} line{preview.hiddenLineCount === 1 ? '' : 's'}</span>
          )}
        </>
      )}
    </div>
  );
}

const SUBAGENT_STATUS: Record<SubagentStatus, string> = {
  running: 'running…',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

export function SubagentCard({ block, expanded }: { block: SubagentBlock; expanded: boolean }) {
  return (
    <div className={`subagent-card${expanded ? ' expanded' : ''}`} data-status={block.status}>
      <div className="subagent-card-header">
        <span className="subagent-card-title">Agent</span>
        <span className="subagent-card-brief">{block.brief}</span>
        {block.model && <span className="subagent-card-model">{block.model}</span>}
        <span className="subagent-card-status">{SUBAGENT_STATUS[block.status]}</span>
      </div>
      {expanded && block.children.length > 0 && (
        <div className="subagent-card-steps">
          {block.children.map((child) => <Block key={child.id} block={child} expanded onShowPlan={noop} />)}
        </div>
      )}
      {block.digest && <div className="subagent-card-digest">{block.digest}</div>}
    </div>
  );
}

function planLabel(block: PlanBlock): string {
  if (block.status === 'building') return 'Building plan…';
  const count = block.taskCount === undefined ? '' : ` · ${block.taskCount} task${block.taskCount === 1 ? '' : 's'}`;
  return `Plan ${block.status}${count}`;
}

function PlanMarker({ block, onShowPlan }: { block: PlanBlock; onShowPlan: () => void }) {
  return (
    <div className="plan-revision-chip-row">
      <button type="button" className="plan-revision-chip" onClick={onShowPlan} title="Show the plan" disabled={block.status === 'building'}>
        {planLabel(block)}
      </button>
    </div>
  );
}

function noop(): void {}

const APPROVAL_KIND: Record<ApprovalKind, string> = {
  shell_command: 'Run a command',
  url_fetch: 'Fetch a URL',
  external_path: 'Read outside the workspace',
};

// The source the policy decided under. `asked` is omitted: a card a user
// answered reads "Approved", not "Approved (asked)".
function approvalSourceLabel(source: ApprovalSource | undefined): string {
  switch (source) {
    case 'pre-approved': return 'pre-approved';
    case 'remembered': return 'remembered';
    case 'mode': return 'policy';
    case 'no-channel': return 'no approval channel';
    default: return '';
  }
}

export function ApprovalCard({ block, onResolve }: { block: ApprovalBlock; onResolve: (id: string, granted: boolean) => void }) {
  const silent = block.decidedBy !== undefined && block.decidedBy !== 'asked';
  const status = block.status === 'pending'
    ? 'Waiting for you'
    : block.status === 'granted'
      ? (silent ? `Auto-approved (${approvalSourceLabel(block.decidedBy)})` : 'Approved')
      : (silent ? `Auto-denied (${approvalSourceLabel(block.decidedBy)})` : 'Denied');
  return (
    <div className={`approval-card ${block.status}`} data-status={block.status}>
      <div className="approval-card-head">
        <span className="approval-card-kind">{APPROVAL_KIND[block.kind]}</span>
        <span className="approval-card-status">{status}</span>
      </div>
      <code className="approval-card-subject">{block.subject}</code>
      {block.detail && <div className="approval-card-detail">{block.detail}</div>}
      <div className="approval-card-scope">
        {block.status === 'pending'
          ? `Approving also allows ${block.scope} for the rest of this session.`
          : `Scope: ${block.scope}`}
      </div>
      {block.status === 'pending' && block.approvalId && (
        <div className="approval-card-actions">
          <button type="button" className="approval-card-allow" onClick={() => onResolve(block.approvalId!, true)}>Allow</button>
          <button type="button" className="approval-card-deny" onClick={() => onResolve(block.approvalId!, false)}>Deny</button>
        </div>
      )}
    </div>
  );
}

function Block({
  block, expanded, onShowPlan, onResolveApproval,
}: {
  block: DisplayBlock;
  expanded: boolean;
  onShowPlan: () => void;
  onResolveApproval: (id: string, granted: boolean) => void;
}) {
  switch (block.type) {
    case 'message':
      return <ChatMessage block={block} />;
    case 'thinking':
      return <ThinkingBlock block={block} expanded={expanded} />;
    case 'tool':
      return <CommandRow block={block} expanded={expanded} />;
    case 'subagent':
      return <SubagentCard block={block} expanded={expanded} />;
    case 'plan':
      return <PlanMarker block={block} onShowPlan={onShowPlan} />;
    case 'approval':
      return <ApprovalCard block={block} onResolve={onResolveApproval} />;
    // The token line is pinned below the conversation, not drawn in it.
    case 'usage':
      return null;
  }
}

const MemoBlock = React.memo(Block);

export function ConversationBlocks({
  blocks, detailAll, onShowPlan, onResolveApproval = noop,
}: {
  blocks: readonly DisplayBlock[];
  detailAll: boolean;
  onShowPlan: () => void;
  onResolveApproval?: (id: string, granted: boolean) => void;
}) {
  return (
    <div className="conversation">
      {blocks.map((block) => (
        <MemoBlock key={block.id} block={block} expanded={detailAll} onShowPlan={onShowPlan} onResolveApproval={onResolveApproval} />
      ))}
    </div>
  );
}
