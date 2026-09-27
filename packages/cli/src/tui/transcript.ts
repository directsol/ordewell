import { reduceConversation, type ConversationInput, type ConversationView, type LocalEntry } from '@ordewell/core';
import type { TuiState } from './state';

/*
 * The one way anything reaches the chat pane: core's conversation reducer.
 * Text is kept exactly as it arrived — a turn adopts the user's prompt only if
 * the two match — and made safe to paint where it is drawn (see `sanitize`).
 */

function fold(state: TuiState, input: ConversationInput): TuiState {
  const conversation = reduceConversation(state.conversation, input);
  if (conversation === state.conversation) return state;
  // A new block snaps a scrolled-back pane to the tail — following the
  // conversation beats keeping the reading position. A block growing in
  // place is the same line still arriving, and leaves the pane where it is.
  const scroll = conversation.nextId > state.conversation.nextId ? 0 : state.scroll;
  return { ...state, conversation, scroll };
}

/** A line the TUI adds itself: the user's prompt, a notice, an error. */
export function say(state: TuiState, role: LocalEntry['role'], text: string): TuiState {
  return fold(state, { type: 'local_entry', role, text });
}

/** A planner message from the session, folded into the conversation. */
export function hear(state: TuiState, message: ConversationInput): TuiState {
  return fold(state, message);
}

/**
 * The pane wiped with the session's bookkeeping kept: ids stay unique, the
 * transcript markers already shown are not shown again by the next plan, and
 * the token line counts the session, not the screen.
 */
export function wiped(view: ConversationView): ConversationView {
  return { ...view, blocks: view.blocks.filter((b) => b.type === 'usage') };
}
