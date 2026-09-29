import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TaskLogEvent } from '../../models/TaskLog';
import { listTaskLogAttempts, openTaskLog, readTaskLog } from '../taskLogStore';

/*
 * Two surfaces opening the same task's next attempt at once (ADR-0018, P1):
 * both list the directory before either creates its file. The listing is
 * made stale by hand here, since no single process can interleave them.
 */

const hooks = vi.hoisted(() => ({
  staleListing: null as string[] | null,
  failCreate: null as NodeJS.ErrnoException | null,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const stale = hooks.staleListing;
      hooks.staleListing = null;
      return stale ?? actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      const failure = hooks.failCreate;
      hooks.failCreate = null;
      if (failure) throw failure;
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
  };
});

describe('taskLogStore under a concurrent open', () => {
  let baseDir: string;
  const where = () => ({ baseDir, sessionId: 'session-race' });
  const turn: TaskLogEvent[] = [{ type: 'turn_start', message: 'Do the task' }, { type: 'text', text: 'Done.' }];

  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tasklog-race-')); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it('takes the number after one another surface just created, and never truncates its file', () => {
    const theirs = openTaskLog(where(), 'task-1');
    theirs.append(turn);

    // This open listed the directory before `1.jsonl` existed.
    hooks.staleListing = [];
    const ours = openTaskLog(where(), 'task-1');

    expect(ours.attempt).toBe(2);
    expect(readTaskLog(where(), 'task-1', 1)).toEqual(turn);
    expect(listTaskLogAttempts(where(), 'task-1')).toEqual([1, 2]);
  });

  it('reports any other failure to create the file instead of looping on it', () => {
    hooks.failCreate = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(() => openTaskLog(where(), 'task-1')).toThrow('EACCES');
    expect(listTaskLogAttempts(where(), 'task-1')).toEqual([]);
  });
});
