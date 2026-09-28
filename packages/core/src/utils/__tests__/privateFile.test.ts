import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writePrivateFile } from '../privateFile';

const isWindows = process.platform === 'win32';

let dir = '';

describe('writePrivateFile', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-private-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the content', () => {
    const file = path.join(dir, 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.readFileSync(file, 'utf8')).toBe('abc');
  });

  it('creates the parent directory owner-only', () => {
    if (isWindows) return;
    const file = path.join(dir, 'nested', 'deep', 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('creates a file readable only by its owner', () => {
    if (isWindows) return;
    const file = path.join(dir, 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing world-readable file to 0600', () => {
    if (isWindows) return;
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o644);

    writePrivateFile(file, 'new');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind', () => {
    const file = path.join(dir, 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.readdirSync(dir)).toEqual(['secret']);
  });

  it('does not follow a symlink planted at the target', () => {
    if (isWindows) return;
    const elsewhere = path.join(dir, 'elsewhere');
    const file = path.join(dir, 'secret');
    fs.writeFileSync(elsewhere, 'original');
    fs.symlinkSync(elsewhere, file);

    writePrivateFile(file, 'new');

    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('original');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
  });
});
