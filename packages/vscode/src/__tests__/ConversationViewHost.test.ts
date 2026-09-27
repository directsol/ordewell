import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DisplayBlock, SessionMessage } from '@ordewell/core';
import { ConversationViewHost } from '../ConversationViewHost';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type PatchedView } from '../shared/conversationPatch';
import type { ConversationPatch, HostToWebview } from '../shared/protocol';

/** A webview stand-in: it keeps only what the host posted, the way App does. */
function webview() {
  const posts: HostToWebview[] = [];
  let view: PatchedView = EMPTY_PATCHED_VIEW;
  return {
    post: (msg: HostToWebview) => {
      posts.push(msg);
      if (msg.type === 'conversationPatch') view = applyConversationPatch(view, msg);
    },
    posts,
    patches: () => posts.filter((m): m is ConversationPatch => m.type === 'conversationPatch'),
    blocks: (): readonly DisplayBlock[] => patchedBlocks(view),
  };
}

const TURN = 't-1';
const started: SessionMessage = { type: 'planner_turn_started', turnId: TURN, prompt: 'add a parser' };
const delta = (text: string, segmentId = 's1'): SessionMessage => ({ type: 'planner_text_delta', turnId: TURN, segmentId, text });

describe('ConversationViewHost', () => {
  let screen: ReturnType<typeof webview>;
  let host: ConversationViewHost;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = webview();
    host = new ConversationViewHost(screen.post);
  });
  afterEach(() => vi.useRealTimers());

  it('draws what the session said, as the shared view has it', () => {
    host.receive(started);
    host.receive(delta('Reading '));
    host.receive(delta('the code.'));
    vi.runAllTimers();

    expect(screen.blocks()).toEqual([
      { type: 'message', id: 'b1', role: 'user', text: 'add a parser', streaming: false, turnId: TURN },
      { type: 'message', id: 'b2', role: 'planner', text: 'Reading the code.', streaming: true, turnId: TURN, segmentId: 's1' },
    ]);
  });

  it('sends a burst of deltas as one patch carrying only the block they grew', () => {
    host.receive(started);
    host.receive(delta('a'));
    vi.runAllTimers();
    const before = screen.patches().length;

    for (const piece of ['b', 'c', 'd', 'e']) host.receive(delta(piece));
    vi.runAllTimers();

    const burst = screen.patches().slice(before);
    expect(burst).toHaveLength(1);
    expect(burst[0].order).toEqual(['b1', 'b2']);
    expect(burst[0].changed).toEqual([expect.objectContaining({ id: 'b2', text: 'abcde' })]);
  });

  it('opens and closes the turn for the webview, each after the view it goes with', () => {
    host.receive(started);
    host.receive(delta('Done.'));
    host.receive({ type: 'planner_message', content: 'Done.', timestamp: '', turnId: TURN });
    host.receive({ type: 'planner_turn_ended', turnId: TURN, outcome: 'message' });

    expect(screen.posts.map((m) => m.type)).toEqual(['conversationPatch', 'plannerTurn', 'conversationPatch', 'plannerTurn']);
    expect(screen.posts[1]).toEqual({ type: 'plannerTurn', active: true });
    expect(screen.posts[3]).toEqual({ type: 'plannerTurn', active: false });
    expect(screen.blocks()[1]).toMatchObject({ text: 'Done.', streaming: false });
  });

  it('passes liveness on to the webview, which has nothing else to show for it', () => {
    host.receive({ type: 'planner_liveness' });

    expect(screen.posts).toEqual([{ type: 'plannerLiveness' }]);
  });

  it('shows the user\'s prompt at once, and the turn that answers it adopts that line', () => {
    host.note('user', 'add a parser');
    host.receive(started);
    vi.runAllTimers();

    expect(screen.blocks()).toEqual([{ type: 'message', id: 'b1', role: 'user', text: 'add a parser', streaming: false, turnId: TURN }]);
  });

  it('adds a notice of its own as a system line', () => {
    host.note('system', 'Approved: npm test');
    vi.runAllTimers();

    expect(screen.blocks()).toEqual([{ type: 'message', id: 'b1', role: 'system', text: 'Approved: npm test', streaming: false }]);
  });

  describe('stop', () => {
    it('closes the open turn on screen at once and frees the input', () => {
      host.receive(started);
      host.receive(delta('Half a thou'));
      host.stop();

      expect(screen.blocks()[1]).toMatchObject({ text: 'Half a thou', streaming: false });
      expect(screen.posts.at(-1)).toEqual({ type: 'plannerTurn', active: false });
    });

    it('drops what the stopped turn still streams while the backend notices the abort', () => {
      host.receive(started);
      host.receive(delta('Half a thou'));
      host.stop();
      host.receive(delta('ght, arriving late'));
      host.receive({ type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}', turnId: TURN });
      host.receive({ type: 'planner_message', content: 'Half a thought, arriving late', timestamp: '', turnId: TURN });
      host.receive({ type: 'planner_turn_ended', turnId: TURN, outcome: 'stopped' });
      vi.runAllTimers();

      expect(screen.blocks().map((b) => b.type === 'message' ? b.text : b.type)).toEqual(['add a parser', 'Half a thou']);
      expect(screen.posts.filter((m) => m.type === 'plannerTurn')).toHaveLength(2);
    });

    it('still counts the stopped turn\'s tokens', () => {
      host.receive(started);
      host.stop();
      host.receive({ type: 'planner_usage', turnId: TURN, totals: { inputTokens: 120, outputTokens: 30 } });
      vi.runAllTimers();

      expect(screen.blocks().at(-1)).toMatchObject({ type: 'usage', totals: { inputTokens: 120, outputTokens: 30 } });
    });

    it('lets the next turn stream', () => {
      host.receive(started);
      host.stop();
      host.receive({ type: 'planner_turn_started', turnId: 't-2', prompt: 'try again' });
      host.receive({ type: 'plan_token', token: '{"tasks":' });
      vi.runAllTimers();

      expect(screen.blocks().at(-1)).toMatchObject({ type: 'plan', status: 'building', text: '{"tasks":' });
    });

    it('does nothing when no turn is open', () => {
      host.stop();
      vi.runAllTimers();

      expect(screen.posts).toEqual([]);
    });
  });

  describe('reload', () => {
    const saved = {
      conversationHistory: [
        { role: 'user' as const, content: 'add a parser', timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant' as const, content: 'Plan generated with 2 tasks.', timestamp: '2026-01-01T00:00:03Z', kind: 'plan_generated' as const },
      ],
      researchLog: [
        { id: 'r1', tool: 'bash' as const, args: '{"command":"ls src"}', result: 'a.ts\nb.ts', timestamp: '2026-01-01T00:00:01Z', success: true, outcome: 'success' as const },
      ],
      plannerUsage: { totals: { inputTokens: 900, outputTokens: 80 }, lastPromptTokens: 700, contextWindow: 10_000 },
    };

    it('rebuilds the view from what the session saved, token line included', () => {
      host.reload(saved);

      expect(screen.blocks()).toEqual([
        { type: 'message', id: 'b1', role: 'user', text: 'add a parser', streaming: false },
        {
          type: 'tool', id: 'b2', tool: 'bash', headline: { name: 'Bash', keyArg: 'ls src' }, args: '{"command":"ls src"}',
          status: 'ok', outcome: 'success', output: 'a.ts\nb.ts', outputLineCount: 2,
        },
        { type: 'plan', id: 'b3', status: 'generated', taskCount: 2, text: '' },
        { type: 'usage', id: 'b4', totals: { inputTokens: 900, outputTokens: 80 }, contextFill: { usedTokens: 700, windowTokens: 10_000 } },
      ]);
    });

    it('replaces a live view whole, though the reloaded ids start over', () => {
      host.receive(started);
      host.receive(delta('live text'));
      vi.runAllTimers();

      host.reload({ conversationHistory: [{ role: 'user', content: 'another session', timestamp: '2026-01-02T00:00:00Z' }] });

      expect(screen.blocks()).toEqual([{ type: 'message', id: 'b1', role: 'user', text: 'another session', streaming: false }]);
    });

    it('never lets a turn from before the reload write into the reloaded view', () => {
      host.receive(started);
      host.reload({ conversationHistory: [] });
      host.receive(delta('from the old session'));
      vi.runAllTimers();

      expect(screen.blocks()).toEqual([]);
      expect(screen.posts.filter((m) => m.type === 'plannerTurn').at(-1)).toEqual({ type: 'plannerTurn', active: false });
    });
  });

  it('empties the view on reset', () => {
    host.note('user', 'hello');
    vi.runAllTimers();
    host.reset();

    expect(screen.blocks()).toEqual([]);
  });

  it('sends a fresh webview the whole view, not just what changed', () => {
    host.note('user', 'hello');
    host.note('system', 'Approved: ls');
    vi.runAllTimers();

    host.resync();

    expect(screen.patches().at(-1)).toEqual({
      type: 'conversationPatch',
      order: ['b1', 'b2'],
      changed: [expect.objectContaining({ id: 'b1', text: 'hello' }), expect.objectContaining({ id: 'b2', text: 'Approved: ls' })],
    });
  });

  it('posts nothing for a message the conversation does not draw', () => {
    host.receive({ type: 'task_output', taskId: 'x', text: 'compiling' });
    vi.runAllTimers();

    expect(screen.posts).toEqual([]);
  });
});
