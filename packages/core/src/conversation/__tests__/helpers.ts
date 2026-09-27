import { EMPTY_CONVERSATION, reduceConversation, type ConversationInput, type ConversationView } from '../reduce';
import type { DisplayBlock } from '../blocks';

export function play(inputs: readonly ConversationInput[], from: ConversationView = EMPTY_CONVERSATION): ConversationView {
  return inputs.reduce(reduceConversation, from);
}

type Unkeyed<T> = T extends { children: readonly (infer C)[] } ? Omit<T, 'id' | 'children'> & { children: Unkeyed<C>[] } : Omit<T, 'id'>;

/** Blocks without their ids, which say nothing about content and are asserted on their own. */
export function unkeyed(blocks: readonly DisplayBlock[]): Unkeyed<DisplayBlock>[] {
  return blocks.map(({ id: _id, ...rest }) => {
    if (rest.type !== 'subagent') return rest;
    return { ...rest, children: rest.children.map(({ id: _childId, ...child }) => child) };
  }) as Unkeyed<DisplayBlock>[];
}
