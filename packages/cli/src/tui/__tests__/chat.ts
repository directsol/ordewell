import type { ConversationView, MessageBlock, MessageRole } from '@ordewell/core';
import type { TuiState } from '../state';

/** A conversation of settled messages, for a state a test starts from. */
export function chatOf(...entries: Array<[MessageRole, string]>): ConversationView {
  return {
    blocks: entries.map(([role, text], i): MessageBlock => ({ type: 'message', id: `b${i + 1}`, role, text, streaming: false })),
    nextId: entries.length + 1,
  };
}

/** The conversation's message blocks, in order. */
export const messagesOf = (state: TuiState): MessageBlock[] =>
  state.conversation.blocks.filter((b): b is MessageBlock => b.type === 'message');

export const lastMessage = (state: TuiState): MessageBlock | undefined => messagesOf(state).at(-1);
