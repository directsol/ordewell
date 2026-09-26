import type { ITerminalSession } from '../interfaces/ITerminalRunner';
import type { BlockingPrompt } from '../plugins/types';
import { stripAnsi } from '../utils/shell';

const TAIL = 4096;

// A TUI paints a dialog with cursor moves between (and sometimes inside) its
// words, so the phrase is compared with every space and case difference gone.
const squash = (text: string): string => stripAnsi(text).replace(/\s+/g, '').toLowerCase();

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
  const pending = prompts.map((prompt) => ({ prompt, phrase: squash(prompt.phrase) }));
  let tail = '';
  session.onOutput((text) => {
    if (pending.length === 0) return;
    tail = (tail + squash(text)).slice(-TAIL);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (!tail.includes(pending[i].phrase)) continue;
      onPrompt(pending[i].prompt);
      pending.splice(i, 1);
    }
  });
}
