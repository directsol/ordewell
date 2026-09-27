import { describe, it, expect } from 'vitest';
import { EMPTY_HOLD, aheadOfDraft, drainNext, holdPrompt, unsendAll, unsendLatest } from '../promptHold';

describe('prompt hold', () => {
  it('sends held prompts in the order they were typed', () => {
    const held = holdPrompt(holdPrompt(EMPTY_HOLD, 'first'), 'second');

    const one = drainNext(held);
    const two = drainNext(one!.rest);

    expect(one?.text).toBe('first');
    expect(two?.text).toBe('second');
    expect(drainNext(two!.rest)).toBeUndefined();
  });

  it('takes back the newest prompt and leaves the older ones to send', () => {
    const held = holdPrompt(holdPrompt(holdPrompt(EMPTY_HOLD, 'one'), 'two'), 'three');

    const unsent = unsendLatest(held);

    expect(unsent).toEqual({ text: 'three', rest: ['one', 'two'] });
    expect(unsendLatest(EMPTY_HOLD)).toBeUndefined();
  });

  it('gives every prompt back at once, in the order typed, when the turn is stopped', () => {
    const held = holdPrompt(holdPrompt(EMPTY_HOLD, 'one'), 'two');

    expect(unsendAll(held)).toEqual({ text: 'one\ntwo', rest: [] });
    expect(unsendAll(EMPTY_HOLD)).toBeUndefined();
  });

  it('puts an unsent prompt back above the draft being typed', () => {
    expect(aheadOfDraft('take this back', 'half a thought')).toBe('take this back\nhalf a thought');
    expect(aheadOfDraft('take this back', '')).toBe('take this back');
  });
});
