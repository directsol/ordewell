import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { OrchestratorPool } from '../orchestratorPool';
import { settingsRoute } from '../../routes/settings';

/** The experimental transport setting (ADR-0018) through the real pool, onto the settings file every surface shares. */
describe('runnerTransport over /api/settings', () => {
  let dir: string;
  let saved: string | undefined;
  let app: Hono;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-transport-'));
    saved = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    app = new Hono();
    app.route('/api/settings', settingsRoute(new OrchestratorPool()));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = async () => (await (await app.request('/api/settings')).json()) as { runnerTransport: string };
  const patch = (body: unknown) => app.request('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('reports terminal until the user opts in', async () => {
    expect((await get()).runnerTransport).toBe('terminal');
  });

  it('persists structured to the shared settings file and reports it back', async () => {
    expect((await patch({ runnerTransport: 'structured' })).status).toBe(200);

    expect((await get()).runnerTransport).toBe('structured');
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')) as { runnerTransport: string };
    expect(file.runnerTransport).toBe('structured');
  });

  it('ignores a value that is not a transport', async () => {
    await patch({ runnerTransport: 'structured' });
    await patch({ runnerTransport: 'telepathy' });
    expect((await get()).runnerTransport).toBe('structured');
  });
});
