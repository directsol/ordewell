/**
 * `playwright` on demand from wherever `npx playwright install chromium`
 * (bench/README.md) left it cached — never as a project dependency. bench/
 * ships zero dependencies of its own, so nothing here is resolvable through
 * ordinary `node_modules` lookup; this finds npx's own cache instead of
 * asking the person running it to export NODE_PATH by hand.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findPlaywrightDir() {
  const npxCache = path.join(os.homedir(), '.npm', '_npx');
  if (!fs.existsSync(npxCache)) return null;
  for (const entry of fs.readdirSync(npxCache)) {
    const dir = path.join(npxCache, entry, 'node_modules', 'playwright');
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

const dir = findPlaywrightDir();
if (!dir) {
  console.error(
    'playwright not found in the npx cache. Run `npx playwright install chromium` first ' +
    '(see bench/README.md) — that also fetches the `playwright` package itself.',
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
export const { chromium } = require(dir);
