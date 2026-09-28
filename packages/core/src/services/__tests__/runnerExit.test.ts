import { describe, it, expect, vi } from 'vitest';
import { classifyRunnerStop, keepsTerminalReadable, stopsRunner, LingeringRunners, type AttemptEnd } from '../runnerExit';

describe('classifyRunnerStop', () => {
  it.each([
    'Claude usage limit reached. Your limit will reset at 5pm.',
    'You have hit your usage limit. The limit will reset at 5pm.',
    'ERROR: rate limit exceeded, retry later',
    'Request was rate-limited',
    'Your weekly limit will reset on Monday',
    'quota exceeded for this project',
    'HTTP 429: Too Many Requests',
  ])('reads an account limit from %j', (output) => {
    expect(classifyRunnerStop(output)).toBe('usage-limit');
  });

  it('treats an ordinary crash as stopped', () => {
    expect(classifyRunnerStop('compilation failed: unexpected token')).toBe('stopped');
    expect(classifyRunnerStop('')).toBe('stopped');
  });

  it('does not read a limit signature buried far above the tail', () => {
    const buried = 'usage limit reached\n' + 'x'.repeat(5000);
    expect(classifyRunnerStop(buried)).toBe('stopped');
    expect(classifyRunnerStop('x'.repeat(5000) + '\nusage limit reached')).toBe('usage-limit');
  });
});

describe('attempt-end disposition', () => {
  it('keeps the terminal readable only on a verdict', () => {
    const reasons: AttemptEnd[] = ['verdict', 'cancel', 'release', 'complete', 'retry', 'spawn-failed', 'stop', 'load'];
    expect(reasons.filter(keepsTerminalReadable)).toEqual(['verdict']);
  });

  it('stops the runner for the reasons that end only that attempt', () => {
    const reasons: AttemptEnd[] = ['verdict', 'cancel', 'release', 'complete', 'retry', 'spawn-failed', 'stop', 'load'];
    expect(reasons.filter(stopsRunner)).toEqual(['cancel', 'release', 'complete', 'retry', 'spawn-failed']);
  });

  it('leaves stop and load to the whole-run reset', () => {
    expect(keepsTerminalReadable('stop')).toBe(false);
    expect(stopsRunner('stop')).toBe(false);
    expect(keepsTerminalReadable('load')).toBe(false);
    expect(stopsRunner('load')).toBe(false);
  });
});

describe('LingeringRunners', () => {
  it('remembers a runner and stops it on close, once', () => {
    const stop = vi.fn();
    const lingering = new LingeringRunners(stop);

    lingering.remember('t1', 's1');
    lingering.close('t1');
    lingering.close('t1');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('s1');
  });

  it('keeps only the latest runner of a task that spawned again', () => {
    const stop = vi.fn();
    const lingering = new LingeringRunners(stop);

    lingering.remember('t1', 's1');
    lingering.remember('t1', 's2');
    lingering.close('t1');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('s2');
  });

  it('is a no-op for a task with no lingering runner', () => {
    const stop = vi.fn();
    const lingering = new LingeringRunners(stop);

    lingering.close('never-ran');

    expect(stop).not.toHaveBeenCalled();
  });
});
