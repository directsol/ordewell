import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageQueue } from '../MessageQueue';
import type { QueuedMessage } from '../../models/Task';

afterEach(() => vi.restoreAllMocks());

describe('MessageQueue', () => {
  it('enqueues in order with distinct ids even within one millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const queue = new MessageQueue();

    queue.enqueue('first');
    queue.enqueue('second');

    const messages = queue.all();
    expect(messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(new Set(messages.map((m) => m.id)).size).toBe(2);
    expect(messages[0].id).toMatch(/^q-1700000000000-1$/);
    expect(messages[1].id).toMatch(/^q-1700000000000-2$/);
  });

  it('hands out a copy, so a caller cannot reshape the queue', () => {
    const queue = new MessageQueue();
    queue.enqueue('hi');

    const copy = queue.all();
    copy.push({ id: 'x', text: 'nope', timestamp: 'now' });

    expect(queue.length).toBe(1);
    expect(queue.all()).toHaveLength(1);
  });

  it('removes a message by id and reports whether it was there', () => {
    const queue = new MessageQueue();
    queue.enqueue('keep');
    queue.enqueue('drop');
    const id = queue.all()[1].id;

    expect(queue.remove(id)).toBe(true);
    expect(queue.remove(id)).toBe(false);
    expect(queue.all().map((m) => m.text)).toEqual(['keep']);
  });

  it('drains oldest first', () => {
    const queue = new MessageQueue();
    queue.enqueue('one');
    queue.enqueue('two');

    expect(queue.next()?.text).toBe('one');
    expect(queue.next()?.text).toBe('two');
    expect(queue.next()).toBeNull();
    expect(queue.length).toBe(0);
  });

  it('replaces and clears wholesale', () => {
    const queue = new MessageQueue();
    queue.enqueue('old');
    const replacement: QueuedMessage[] = [{ id: 'a', text: 'new', timestamp: 'now' }];

    queue.replace(replacement);
    replacement.push({ id: 'b', text: 'later', timestamp: 'now' });

    expect(queue.all().map((m) => m.text)).toEqual(['new']);

    queue.clear();
    expect(queue.length).toBe(0);
  });
});
