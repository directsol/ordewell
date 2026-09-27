import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { DisplayBlock, MessageBlock, SubagentBlock, ThinkingDisplayBlock, ToolBlock } from '@ordewell/core';
import ChatMessage, { CommandRow, ConversationBlocks, SubagentCard, ThinkingBlock, renderMarkdown } from '../ChatMessage';

const message = (over: Partial<MessageBlock>): MessageBlock => ({ type: 'message', id: 'm', role: 'planner', text: '', streaming: false, ...over });
const thinking = (over: Partial<ThinkingDisplayBlock> = {}): ThinkingDisplayBlock => ({
  type: 'thinking', id: 'th', text: 'First I read the config.\nThen the tests.', streaming: false, ...over,
});
const tool = (over: Partial<ToolBlock> = {}): ToolBlock => ({
  type: 'tool', id: 'tl', tool: 'bash', headline: { name: 'Bash', keyArg: 'ls -la' }, args: '{"command":"ls -la"}',
  status: 'ok', outcome: 'success', output: 'one\ntwo\nthree\nfour\nfive', outputLineCount: 5, ...over,
});
const subagent = (over: Partial<SubagentBlock> = {}): SubagentBlock => ({
  type: 'subagent', id: 'sa', subagentId: 'x', brief: 'explore the auth module', status: 'done',
  children: [tool({ id: 'c1', headline: { name: 'Read', keyArg: 'src/auth.ts' }, output: 'export {}', outputLineCount: 1 })],
  digest: 'Auth uses JWT.', ...over,
});

describe('ChatMessage', () => {
  it('shows the user\'s words as typed', () => {
    const { container } = render(<ChatMessage block={message({ role: 'user', text: 'use **JWT**' })} />);
    expect(container.querySelector('.chat-msg-user .chat-msg-content')!.textContent).toBe('use **JWT**');
  });

  it('renders a planner reply as markdown', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Use **JWT** in `auth.ts`' })} />);
    expect(container.querySelector('.chat-msg-planner strong')!.textContent).toBe('JWT');
    expect(container.querySelector('.chat-msg-planner code')!.textContent).toBe('auth.ts');
  });

  it('renders a reply still streaming as markdown, marked live', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Reading **the', streaming: true })} />);
    expect(container.querySelector('.chat-msg-planner.streaming .chat-msg-content')!.textContent).toBe('Reading **the');
    expect(container.querySelector('.chat-msg-cursor')).toBeTruthy();
  });

  it('shows a notice as a muted system line and an error as an error line', () => {
    const { container } = render(<>
      <ChatMessage block={message({ id: 'a', role: 'system', text: 'Approved: npm test' })} />
      <ChatMessage block={message({ id: 'b', role: 'error', text: 'Planner failed' })} />
    </>);
    expect(container.querySelector('.chat-msg-system')!.textContent).toBe('Approved: npm test');
    expect(container.querySelector('.chat-msg-error')!.textContent).toBe('Planner failed');
  });
});

describe('ThinkingBlock', () => {
  it('is one line when collapsed', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded={false} />);
    expect(container.querySelector('.activity-think-head')!.textContent).toContain('Thinking');
    expect(container.querySelector('.activity-think-line')!.textContent).toBe('First I read the config.');
    expect(container.querySelector('.activity-think-pre')).toBeNull();
  });

  it('says it is still thinking while it streams', () => {
    const { container } = render(<ThinkingBlock block={thinking({ streaming: true })} expanded={false} />);
    expect(container.querySelector('.activity-think-head')!.textContent).toContain('Thinking…');
  });

  it('shows all of it when expanded', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded />);
    expect(container.querySelector('.activity-think-pre')!.textContent).toBe('First I read the config.\nThen the tests.');
  });

  it('does not open on a click: detail is one switch for the whole conversation', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded={false} />);
    fireEvent.click(container.querySelector('.activity-think')!);
    expect(container.querySelector('.activity-think-pre')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('CommandRow', () => {
  it('heads the row with the tool and its main argument, in monospace', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    const head = container.querySelector('code.cmd-row-head')!;
    expect(head.textContent).toBe('Bash(ls -la)');
  });

  it('previews three lines of output and counts the rest', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('one\ntwo\nthree');
    expect(container.querySelector('.cmd-row-more')!.textContent).toBe('+2 lines');
    expect(container.querySelector('.cmd-row-args')).toBeNull();
  });

  it('shows no count when the output fits', () => {
    const { container } = render(<CommandRow block={tool({ output: 'one\ntwo', outputLineCount: 2 })} expanded={false} />);
    expect(container.querySelector('.cmd-row-more')).toBeNull();
  });

  it('shows the full arguments and output when expanded', () => {
    const { container } = render(<CommandRow block={tool()} expanded />);
    expect(container.querySelector('.cmd-row-args')!.textContent).toBe('{\n  "command": "ls -la"\n}');
    expect(container.querySelector('.cmd-row-output')!.textContent).toBe('one\ntwo\nthree\nfour\nfive');
    expect(container.querySelector('.cmd-row-more')).toBeNull();
  });

  it('marks a pending call, and names an outcome that is not a plain success', () => {
    const { container } = render(<>
      <CommandRow block={tool({ id: 'a', status: 'pending', outcome: undefined, output: '', outputLineCount: 0 })} expanded={false} />
      <CommandRow block={tool({ id: 'b', status: 'denied', outcome: 'refused', output: 'Command refused', outputLineCount: 1 })} expanded={false} />
    </>);
    const rows = container.querySelectorAll('.cmd-row');
    expect(rows[0].getAttribute('data-status')).toBe('pending');
    expect(rows[1].getAttribute('data-status')).toBe('denied');
    expect(rows[1].querySelector('.cmd-row-outcome')!.textContent).toBe('refused');
  });

  it('does not open on a click', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    fireEvent.click(container.querySelector('.cmd-row-head')!);
    expect(container.querySelector('.cmd-row-output')).toBeNull();
  });
});

describe('SubagentCard', () => {
  it('shows its brief, status and digest when collapsed, but not its steps', () => {
    const { container } = render(<SubagentCard block={subagent()} expanded={false} />);
    expect(container.querySelector('.subagent-card-brief')!.textContent).toBe('explore the auth module');
    expect(container.querySelector('.subagent-card-status')!.textContent).toBe('done');
    expect(container.querySelector('.subagent-card-digest')!.textContent).toBe('Auth uses JWT.');
    expect(container.querySelector('.subagent-card-steps')).toBeNull();
  });

  it('says a subagent is still running', () => {
    const { container } = render(<SubagentCard block={subagent({ status: 'running', digest: '' })} expanded={false} />);
    expect(container.querySelector('.subagent-card')!.getAttribute('data-status')).toBe('running');
    expect(container.querySelector('.subagent-card-status')!.textContent).toBe('running…');
    expect(container.querySelector('.subagent-card-digest')).toBeNull();
  });

  it('shows its nested steps, themselves expanded, when expanded', () => {
    const { container } = render(<SubagentCard block={subagent()} expanded />);
    const steps = container.querySelector('.subagent-card-steps')!;
    expect(steps.querySelector('code.cmd-row-head')!.textContent).toBe('Read(src/auth.ts)');
    expect(steps.querySelector('.cmd-row-output')!.textContent).toBe('export {}');
  });
});

describe('ConversationBlocks', () => {
  const blocks: DisplayBlock[] = [
    message({ id: 'u', role: 'user', text: 'add a parser' }),
    thinking({ id: 'th' }),
    tool({ id: 'tl' }),
    subagent({ id: 'sa' }),
    message({ id: 'p', text: 'Done.' }),
  ];

  it('draws every block in order', () => {
    const { container } = render(<ConversationBlocks blocks={blocks} detailAll={false} onShowPlan={() => {}} />);
    const kinds = Array.from(container.querySelector('.conversation')!.children).map((el) => el.className.split(' ')[0]);
    expect(kinds).toEqual(['chat-msg', 'activity-think', 'cmd-row', 'subagent-card', 'chat-msg']);
  });

  it('collapses every thinking, command and subagent block with detail off, and expands them all with it on', () => {
    const { container, rerender } = render(<ConversationBlocks blocks={blocks} detailAll={false} onShowPlan={() => {}} />);
    expect(container.querySelectorAll('.activity-think-pre, .cmd-row-output, .subagent-card-steps')).toHaveLength(0);

    rerender(<ConversationBlocks blocks={blocks} detailAll onShowPlan={() => {}} />);
    expect(container.querySelectorAll('.activity-think-pre')).toHaveLength(1);
    expect(container.querySelectorAll('.subagent-card-steps')).toHaveLength(1);
    // The top-level row and the one nested in the subagent.
    expect(container.querySelectorAll('.cmd-row-output')).toHaveLength(2);
  });

  it('opens the plan from a plan marker', () => {
    const onShowPlan = vi.fn();
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'generated', taskCount: 3, text: '' }]} detailAll={false} onShowPlan={onShowPlan} />,
    );
    fireEvent.click(getByText('Plan generated · 3 tasks'));
    expect(onShowPlan).toHaveBeenCalled();
  });

  it('says a plan is being built while it streams', () => {
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'building', text: '{"tasks":' }]} detailAll={false} onShowPlan={() => {}} />,
    );
    expect(getByText('Building plan…')).toBeTruthy();
  });

  it('marks an updated plan with its task count', () => {
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'updated', taskCount: 2, text: '' }]} detailAll={false} onShowPlan={() => {}} />,
    );
    expect(getByText('Plan updated · 2 tasks')).toBeTruthy();
  });
});

describe('renderMarkdown on planner text', () => {
  const parsed = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  };
  const linkOf = (html: string) => parsed(html).querySelector('a');

  it('lets no quote in a link carry an attribute out of its href', () => {
    const html = parsed(renderMarkdown('[docs](https://x.test/" style="position:fixed;inset:0" data-x=")'));

    expect(html.querySelector('[style]')).toBeNull();
    expect(html.querySelector('[data-x]')).toBeNull();
  });

  it('links only web URLs; anything else stays text', () => {
    expect(linkOf(renderMarkdown('[run](javascript:alert(1))'))).toBeNull();
    expect(linkOf(renderMarkdown('[docs](https://example.com/a)'))?.getAttribute('href')).toBe('https://example.com/a');
  });
});
