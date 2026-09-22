import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { readFinalAssistantText } from '../transcriptCapture';

const HOME_BACKUP = process.env.HOME;
let fakeHome: string;

beforeAll(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), 'transcript-'));
  process.env.HOME = fakeHome;
});

afterAll(() => {
  process.env.HOME = HOME_BACKUP;
  rmSync(fakeHome, { recursive: true, force: true });
});

const CWD = '/repo/work';
const MUNGED = '-repo-work';

function claudeLine(type: string, body: object): string {
  return JSON.stringify({ type, ...body });
}

describe('readFinalAssistantText', () => {
  it('returns null for an unknown runner', async () => {
    expect(await readFinalAssistantText({ runner: 'unknown-agent', cwd: CWD })).toBeNull();
  });

  it('returns null when no store exists at all', async () => {
    expect(await readFinalAssistantText({ runner: 'claude-code', cwd: CWD })).toBeNull();
  });

  describe('claude-code', () => {
    it('extracts the last assistant text block from the newest session file', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', MUNGED);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'aaaa.jsonl'),
        [
          claudeLine('user', { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
          claudeLine('assistant', { isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'first draft' }] } }),
          claudeLine('assistant', { isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'The migration is complete and tests pass.' }] } }),
          // sidechain (subagent) text must be ignored
          claudeLine('assistant', { isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
          'not json at all',
        ].join('\n'),
      );
      const out = await readFinalAssistantText({ runner: 'claude-code', cwd: CWD });
      expect(out).toBe('The migration is complete and tests pass.');
    });

    it('skips sessions last modified before the task started', async () => {
      // Distinct cwd so the previous test's files can't answer for this one.
      const cwd2 = '/repo/other';
      const dir = path.join(fakeHome, '.claude', 'projects', '-repo-other');
      mkdirSync(dir, { recursive: true });
      const old = path.join(dir, 'old.jsonl');
      writeFileSync(old, claudeLine('assistant', { message: { content: [{ type: 'text', text: 'stale session' }] } }));
      // Backdate the transcript to before the (future) task start, the way a
      // pre-existing session in the same directory would look.
      const past = new Date(Date.now() - 60_000);
      utimesSync(old, past, past);
      const out = await readFinalAssistantText({ runner: 'claude-code', cwd: cwd2, startedAt: new Date().toISOString() });
      expect(out).toBeNull();
    });

    it('returns null when the munged directory holds no assistant text', async () => {
      // A cwd whose munged dir exists but only holds non-assistant records.
      const cwd3 = '/repo/empty';
      const dir = path.join(fakeHome, '.claude', 'projects', '-repo-empty');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'x.jsonl'), claudeLine('user', { message: { content: [{ type: 'text', text: 'only a user line' }] } }));
      expect(await readFinalAssistantText({ runner: 'claude-code', cwd: cwd3 })).toBeNull();
    });
  });

  describe('opencode', () => {
    it('reads the newest assistant text part via node:sqlite', async () => {
      // The real store lives under ~/.local/share/opencode; this test only
      // exercises the graceful-null path when the DB is absent. The real-DB
      // extraction is verified by scripts/verify-transcript-capture.mjs
      // against the live store.
      const out = await readFinalAssistantText({ runner: 'opencode', cwd: '/nonexistent/cwd' });
      expect(out).toBeNull();
    });
  });

  describe('codex', () => {
    it('binds a rollout to the task cwd via session_meta and takes the last assistant message', async () => {
      const day = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '22');
      mkdirSync(day, { recursive: true });
      writeFileSync(
        path.join(day, 'rollout-2026-09-22T10-00-00-aaaa.jsonl'),
        [
          JSON.stringify({ timestamp: '2026-09-22T10:00:00Z', type: 'session_meta', payload: { cwd: CWD, session_id: 'a1' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'final codex answer' }] } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'user line is not the answer' }] } }),
        ].join('\n'),
      );
      // A rollout from another cwd must NOT answer.
      writeFileSync(
        path.join(day, 'rollout-2026-09-22T11-00-00-bbbb.jsonl'),
        [
          JSON.stringify({ timestamp: '2026-09-22T11:00:00Z', type: 'session_meta', payload: { cwd: '/elsewhere', session_id: 'b1' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'wrong session' }] } }),
        ].join('\n'),
      );
      const out = await readFinalAssistantText({ runner: 'codex', cwd: CWD });
      expect(out).toBe('final codex answer');
    });
  });
});