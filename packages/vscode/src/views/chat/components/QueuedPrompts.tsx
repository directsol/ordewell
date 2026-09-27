import React from 'react';
import type { PromptHold } from '@ordewell/core/plan-utils';

interface QueuedPromptsProps {
  prompts: PromptHold;
  onUnsend: () => void;
}

/**
 * Prompts held for the next planner turn, drawn after the conversation they
 * join once sent. Only the newest carries the ×: unsend always takes the
 * newest, as Esc does, so the button never promises to take back another.
 */
export default function QueuedPrompts({ prompts, onUnsend }: QueuedPromptsProps) {
  if (prompts.length === 0) return null;
  const newest = prompts.length - 1;
  return (
    <div className="conversation-queued" aria-label="Queued prompts">
      {prompts.map((text, i) => (
        <div key={i} className="queued-prompt">
          <div className="queued-prompt-bubble">{text}</div>
          <div className="queued-prompt-meta">
            {i === newest ? 'queued · esc to unsend' : 'queued'}
            {i === newest && (
              <button
                type="button"
                className="queued-prompt-unsend"
                title="Unsend (Esc)"
                aria-label={`Unsend queued prompt: ${text}`}
                onClick={onUnsend}
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
