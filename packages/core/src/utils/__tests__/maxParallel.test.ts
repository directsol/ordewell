import { describe, it, expect } from 'vitest';
import { parseMaxParallel } from '../maxParallel';

describe('parseMaxParallel', () => {
  it('takes any whole number of 1 or more, with no ceiling', () => {
    expect(parseMaxParallel('1')).toBe(1);
    expect(parseMaxParallel(' 12 ')).toBe(12);
    expect(parseMaxParallel(40)).toBe(40);
  });

  it('refuses zero, negatives, fractions and words', () => {
    for (const value of ['0', '-2', '2.5', 'lots', '', undefined, null]) expect(parseMaxParallel(value)).toBeNull();
  });
});
