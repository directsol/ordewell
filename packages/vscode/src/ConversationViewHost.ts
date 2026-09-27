import type { LegacyPlanState, SessionMessage } from '@ordewell/core';
// The browser-safe entry, so the webview's tests can run the host's view too.
import {
  drainNext, EMPTY_CONVERSATION, EMPTY_HOLD, fromTranscript, holdPrompt, reduceConversation, unsendAll, unsendLatest,
  type ConversationInput, type ConversationView, type DisplayBlock, type LocalEntry, type PromptHold,
} from '@ordewell/core/plan-utils';
import { diffConversation } from './shared/conversationPatch';
import type { HostToWebview } from './shared/protocol';

const FLUSH_MS = 30;

export type SavedConversation = Pick<LegacyPlanState, 'conversationHistory' | 'researchLog' | 'plannerUsage'>;

/** What a turn streams — everything a stop cuts off. Usage, approvals and transcript markers are facts and still land. */
const TURN_STREAM = new Set<SessionMessage['type']>([
  'planner_text_delta', 'planner_thinking_delta', 'planner_text_retracted', 'planner_message', 'plan_token',
  'research_step', 'research_step_done', 'subagent_started', 'subagent_finished', 'planner_turn_ended',
]);

/**
 * The planner conversation the chat webview draws (#53), held on the host:
 * session events and local notices fold into core's view here, and the webview
 * only ever mirrors it.
 *
 * It goes out as block patches, not snapshots. A snapshot re-sends every block
 * — every command's full output — on each text delta, so a delta late in a
 * long session would cost the whole session so far. Core's reducer keeps each
 * untouched block's identity, so a patch costs only the blocks that changed.
 * Deltas also arrive faster than a frame, so patches wait `FLUSH_MS` and go out
 * as one per burst, which is one webview render rather than one per token.
 *
 * It also holds the queued prompts — what the user typed while a turn was in
 * flight — because they belong to this conversation: a reset or a reloaded
 * session drops them along with the view they were written against.
 */
export class ConversationViewHost {
  private view: ConversationView = EMPTY_CONVERSATION;
  private sent: readonly DisplayBlock[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openTurnId: string | null = null;
  private stoppedTurnId: string | null = null;
  private held: PromptHold = EMPTY_HOLD;

  constructor(private readonly post: (msg: HostToWebview) => void) {}

  get blocks(): readonly DisplayBlock[] {
    return this.view.blocks;
  }

  receive(msg: SessionMessage): void {
    if (msg.type === 'planner_liveness') {
      this.post({ type: 'plannerLiveness' });
      return;
    }
    if (msg.type === 'planner_turn_started') this.stoppedTurnId = null;
    if (this.cutOff(msg)) {
      if (msg.type === 'planner_turn_ended') this.stoppedTurnId = null;
      return;
    }
    this.fold(msg);
    if (msg.type === 'planner_turn_started') this.openTurn(msg.turnId);
    if (msg.type === 'planner_turn_ended') this.closeTurn();
  }

  note(role: LocalEntry['role'], text: string): void {
    this.fold({ type: 'local_entry', role, text });
  }

  holdPrompt(text: string): void {
    this.showHeld(holdPrompt(this.held, text));
  }

  /**
   * The host decides what comes back, not the webview: a prompt the turn's end
   * drained in the meantime has already gone, and must not also reappear.
   */
  unsendPrompt(): void {
    const latest = unsendLatest(this.held);
    if (!latest) return;
    this.post({ type: 'promptUnsent', text: latest.text });
    this.showHeld(latest.rest);
  }

  /**
   * The oldest queued prompt, taken out of the hold for the caller to send.
   * Asked by whoever owns the host's turn once it has fully ended — the
   * `planner_turn_ended` event comes while the turn is still unwinding, too
   * early to start the next one.
   */
  nextPrompt(): string | undefined {
    const next = drainNext(this.held);
    if (!next) return undefined;
    this.showHeld(next.rest);
    return next.text;
  }

  /**
   * The user stopped the planner. The turn ends on screen now rather than when
   * the backend notices the abort, and whatever it still streams until its
   * real end is dropped. Queued prompts go back to the input rather than
   * following the stop — the host may not have opened the turn yet, so they
   * are released whether or not one is.
   */
  stop(): void {
    const all = unsendAll(this.held);
    if (all) {
      this.post({ type: 'promptUnsent', text: all.text });
      this.showHeld(all.rest);
    }
    if (this.openTurnId === null) return;
    this.stoppedTurnId = this.openTurnId;
    this.fold({ type: 'planner_turn_ended', turnId: this.openTurnId, outcome: 'stopped' });
    this.closeTurn();
  }

  /** The view a saved session reopens with, built from its records alone (#51). */
  reload(saved: SavedConversation): void {
    this.replace(fromTranscript(saved.conversationHistory, saved.researchLog, saved.plannerUsage));
  }

  reset(): void {
    this.replace(EMPTY_CONVERSATION);
  }

  /** A new webview holds nothing, so it is sent every block. */
  resync(): void {
    this.sent = [];
    this.flush();
    this.post({ type: 'heldPrompts', prompts: this.held });
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const patch = diffConversation(this.sent, this.view.blocks);
    this.sent = this.view.blocks;
    if (patch) this.post(patch);
  }

  // A turn still open belongs to the view being replaced; stopping it keeps
  // its late output out of the new one. Its queued prompts are dropped, not
  // given back: they were written for a conversation that is gone.
  private replace(view: ConversationView): void {
    if (this.held.length > 0) this.showHeld(EMPTY_HOLD);
    this.stop();
    this.view = view;
    this.flush();
  }

  private showHeld(held: PromptHold): void {
    this.held = held;
    this.post({ type: 'heldPrompts', prompts: held });
  }

  private cutOff(msg: SessionMessage): boolean {
    if (this.stoppedTurnId === null || !TURN_STREAM.has(msg.type)) return false;
    const turnId = 'turnId' in msg ? msg.turnId : undefined;
    return turnId === undefined || turnId === this.stoppedTurnId;
  }

  private openTurn(turnId: string): void {
    this.openTurnId = turnId;
    this.flush();
    this.post({ type: 'plannerTurn', active: true });
  }

  private closeTurn(): void {
    this.openTurnId = null;
    this.flush();
    this.post({ type: 'plannerTurn', active: false });
  }

  private fold(input: ConversationInput): void {
    this.update(reduceConversation(this.view, input));
  }

  private update(next: ConversationView): void {
    if (next === this.view) return;
    this.view = next;
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }
}
