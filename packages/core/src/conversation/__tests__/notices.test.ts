import { describe, it, expect } from 'vitest';
import { taskStartedNotice } from '../notices';

describe('task notices', () => {
  it('names the task and the runner it started on', () => {
    expect(taskStartedNotice('Add a parser', 'claude-code')).toBe('Started "Add a parser" · claude-code');
  });

  it('leaves the runner out when none is known', () => {
    expect(taskStartedNotice('Add a parser')).toBe('Started "Add a parser"');
  });
});
