import type { ITerminalSession } from '../interfaces/ITerminalRunner';
import type { BlockingPrompt } from '../plugins/types';
import { stripAnsi } from '../utils/shell';

const TAIL = 4096;

// A TUI paints a dialog with cursor moves between (and sometimes inside) its
// words, so the phrase is compared with every space and case difference gone.
const squash = (text: string): string => stripAnsi(text).replace(/\s+/g, '').toLowerCase();

/** The declared prompts a (whitespace- and ANSI-squashed) tail of session output shows, in declaration order. */
function shownInSquashed(squashedTail: string, prompts: readonly BlockingPrompt[]): BlockingPrompt[] {
  return prompts.filter((prompt) => squashedTail.includes(squash(prompt.phrase)));
}

/**
 * Which of the declared prompts this output shows, in declaration order. Pure:
 * the live watcher asks the same question incrementally about the tail it has
 * accumulated, so the matching rule is testable without a terminal.
 */
export function shownPrompts(output: string, prompts: readonly BlockingPrompt[]): BlockingPrompt[] {
  return shownInSquashed(squash(output).slice(-TAIL), prompts);
}

/**
 * Calls `onPrompt` once per declared prompt the session's output shows. The
 * agent answers none of these itself and Ordewell never answers them for it —
 * a folder-trust or permission-mode confirmation is the user's to give — so
 * this only turns an indefinite silent wait into one the user is told about.
 */
export function watchBlockingPrompts(
  session: ITerminalSession,
  prompts: readonly BlockingPrompt[],
  onPrompt: (prompt: BlockingPrompt) => void,
): void {
  if (prompts.length === 0) return;
  let pending = [...prompts];
  let tail = '';
  session.onOutput((text) => {
    if (pending.length === 0) return;
    tail = (tail + squash(text)).slice(-TAIL);
    const shown = shownInSquashed(tail, pending);
    if (shown.length === 0) return;
    pending = pending.filter((prompt) => !shown.includes(prompt));
    for (let i = shown.length - 1; i >= 0; i--) onPrompt(shown[i]);
  });
}
