import { describe, it, expect, vi } from 'vitest';
import { watchBlockingPrompts } from '../blockingPrompts';
import { FakeTerminalSession } from '../../testing';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';

describe('watchBlockingPrompts', () => {
  const prompts = CLAUDE_CODE_MANIFEST.runner.blockingPrompts!;

  it("spots Claude Code's folder-trust dialog painted with cursor moves, across chunks, once", () => {
    const session = new FakeTerminalSession('s1', 't1');
    const onPrompt = vi.fn();
    watchBlockingPrompts(session, prompts, onPrompt);

    session.emitOutput(' Quick safety check: \x1b[1CIs this a project you \x1b[38;5;2mcreated or');
    session.emitOutput(' one you\r\n trust? (Like your own code)');
    session.emitOutput(' Is this a project you created or one you trust?');

    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt.mock.calls[0][0].asks).toBe("whether to trust the task's folder");
  });

  it('stays quiet for ordinary agent output', () => {
    const session = new FakeTerminalSession('s1', 't1');
    const onPrompt = vi.fn();
    watchBlockingPrompts(session, prompts, onPrompt);

    session.emitOutput('● Update(CHANGELOG.md)\n  ⏵⏵ bypass permissions on (shift+tab to cycle)');

    expect(onPrompt).not.toHaveBeenCalled();
  });
});
