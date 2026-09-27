import type { DisplayBlock } from './blocks';

/**
 * Whether the conversation holds anything the collapsed view hides — thinking,
 * a command row's arguments and output, a subagent's children and digest. The
 * detail toggle is the only expansion control (ADR-0017, X1), so a surface
 * offers it only when it would do something.
 */
export function hasHiddenDetail(blocks: readonly DisplayBlock[]): boolean {
  return blocks.some((b) => b.type === 'thinking' || b.type === 'tool' || b.type === 'subagent');
}
