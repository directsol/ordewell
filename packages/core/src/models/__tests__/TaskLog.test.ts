import { describe, it, expect } from 'vitest';
import { coalesceTaskLog, toTaskLogEvent, trimToolOutput, type TaskLogEvent } from '../TaskLog';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('trimToolOutput', () => {
  it('keeps a short result whole', () => {
    expect(trimToolOutput(lines(100))).toEqual({ output: lines(100) });
  });

  it('keeps the head and tail of a long result and counts what it left out', () => {
    const { output, omittedLines } = trimToolOutput(lines(1000));
    const kept = output.split('\n');
    expect(omittedLines).toBe(900);
    expect(kept.slice(0, 2)).toEqual(['line 1', 'line 2']);
    expect(kept[60]).toBe('… 900 lines omitted …');
    expect(kept[kept.length - 1]).toBe('line 1000');
    expect(kept).toHaveLength(101);
  });

  it('cuts a single enormous line, which no line count would catch', () => {
    const { output, omittedLines } = trimToolOutput('x'.repeat(50_000));
    expect(omittedLines).toBeUndefined();
    expect(output.length).toBeLessThan(2100);
    expect(output.endsWith('…')).toBe(true);
  });
});

describe('toTaskLogEvent', () => {
  it('keeps a call’s arguments as JSON and its subagent', () => {
    expect(toTaskLogEvent({ type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'a.ts' }, subagentId: 'sa' }))
      .toEqual({ type: 'tool_call', id: 'c1', name: 'Read', args: '{"file_path":"a.ts"}', subagentId: 'sa' });
  });

  it('trims a long result on the way in, so the file and the live stream carry the same text', () => {
    const event = toTaskLogEvent({ type: 'tool_result', id: 'c1', name: '', output: lines(500), success: true });
    expect(event).toMatchObject({ type: 'tool_result', id: 'c1', success: true, omittedLines: 400 });
  });

  it('names the queued message a turn delivers', () => {
    expect(toTaskLogEvent({ type: 'turn_start', text: 'also add tests', messageId: 'msg-2' }))
      .toEqual({ type: 'turn_start', message: 'also add tests', messageId: 'msg-2' });
    expect(toTaskLogEvent({ type: 'turn_start', text: 'Do the task' })).toEqual({ type: 'turn_start', message: 'Do the task' });
  });

  it('leaves out permission requests and background launches', () => {
    expect(toTaskLogEvent({ type: 'permission_request', id: 'p', name: 'Bash', detail: 'rm' })).toBeNull();
    expect(toTaskLogEvent({ type: 'background_agent', id: 'a' })).toBeNull();
  });
});

describe('coalesceTaskLog', () => {
  it('merges runs of deltas and nothing else', () => {
    const events: TaskLogEvent[] = [
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'thinking_delta', text: 'a' },
      { type: 'thinking_delta', text: 'b', subagentId: 'sa' },
      { type: 'thinking_delta', text: 'c', subagentId: 'sa' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' again' },
    ];
    expect(coalesceTaskLog(events)).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'thinking_delta', text: 'a' },
      { type: 'thinking_delta', text: 'bc', subagentId: 'sa' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' again' },
    ]);
  });
});
