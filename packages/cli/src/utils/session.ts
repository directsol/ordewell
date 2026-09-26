import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getStateDir } from '@ordewell/core';

const LAST_SESSION_FILENAME = 'last-session.json';

// Colocated with a workspace's own .ordewell/sessions/ rather than a global
// pointer: a global "last session" let a one-shot command in one terminal
// (add-task, run, stop, ...) silently fall back to whatever session another
// terminal — in a different workspace entirely — had most recently touched.
// Scoping the pointer file to the workspace makes that structurally
// impossible: `readLastSession(workspace)` can only ever return a session
// that was last active in that same workspace.
function lastSessionFile(workspace: string): string {
  return join(getStateDir(workspace), LAST_SESSION_FILENAME);
}

export function saveLastSession(sessionId: string, goal: string, runners: string[], workspace: string): void {
  const dir = getStateDir(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    lastSessionFile(workspace),
    JSON.stringify({ sessionId, goal, runners, workspace, createdAt: new Date().toISOString() }, null, 2),
  );
}

export function readLastSession(workspace: string): { sessionId: string; goal: string; runners: string[]; workspace: string } | null {
  try {
    const file = lastSessionFile(workspace);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }
  } catch { /* empty */ }
  return null;
}

const SESSION_PREFIX = 'session-';

/**
 * A full session id from the short form `ordewell status` prints (its last
 * eight characters) or any other unambiguous piece of one, looked up among the
 * workspace's saved sessions. Anything else comes back unchanged, for the
 * daemon to accept or refuse as before.
 */
export function expandSessionId(id: string, workspace: string): string {
  if (id.startsWith(SESSION_PREFIX)) return id;
  let files: string[];
  try {
    files = readdirSync(join(getStateDir(workspace), 'sessions')).filter((f) => f.endsWith('.json'));
  } catch {
    return id;
  }
  const matches = new Set<string>();
  for (const file of files) {
    try {
      const full = JSON.parse(readFileSync(join(getStateDir(workspace), 'sessions', file), 'utf8'))?.meta?.id;
      if (typeof full === 'string' && (full.endsWith(id) || full.slice(SESSION_PREFIX.length).startsWith(id))) matches.add(full);
    } catch { /* a half-written session is no candidate */ }
  }
  return matches.size === 1 ? [...matches][0] : id;
}
