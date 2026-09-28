import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'fs';
import { basename, dirname, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Files only their owner may read: API keys in `~/.ordewell/.env`, the daemon's
 * bearer token. A `mode` argument to `writeFileSync` is honoured only when the
 * file is *created*, so a plain write over an existing file — or one another
 * process pre-created — keeps that file's old permissions. Writing a fresh temp
 * file and renaming it over the target sidesteps this: the replacement is
 * always 0600 whatever the old mode was, and a symlink planted at the target is
 * replaced rather than followed. The rename is atomic within a directory, so a
 * reader never observes a half-written secret.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// POSIX permission bits mean nothing on Windows; asking for them there is
// harmless but has no effect, so the platform check documents the intent.
const POSIX_MODES = process.platform !== 'win32';

/** Create `dir` (and its parents) owner-only, leaving any existing directory at its own mode. */
export function ensurePrivateDir(dir: string): void {
  if (POSIX_MODES) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return;
  }
  mkdirSync(dir, { recursive: true });
}

/** Write `content` to `filePath`, atomically, ending at 0600 on POSIX. */
export function writePrivateFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  ensurePrivateDir(dir);

  // Same directory as the target so the rename stays on one filesystem; random
  // so the name can never be pre-planted.
  const tempPath = join(dir, `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tempPath, 'wx', POSIX_MODES ? FILE_MODE : undefined);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Already gone; the rename error is the one worth reporting.
    }
    throw err;
  }
}
