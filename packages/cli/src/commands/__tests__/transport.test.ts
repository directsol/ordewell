import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleTransport } from '../transport';

function fakeApi(settings: Record<string, unknown>) {
  return {
    sendCommand: vi.fn(async (_name: string, args: Record<string, string>) => ({ ok: true, settings: { runnerTransport: args.action } })),
    getSettings: vi.fn(async () => settings),
  };
}

async function printed(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  await fn();
  spy.mockRestore();
  return logs.join('\n');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('handleTransport', () => {
  it.each([
    ['terminal', 'terminal'],
    ['structured', 'structured'],
  ])('%s sets it through the daemon command and names it', async (transport, label) => {
    const api = fakeApi({});
    const out = await printed(() => handleTransport([transport], api as unknown as ApiClient));
    expect(api.sendCommand).toHaveBeenCalledWith('transport', { action: transport });
    expect(out).toContain(`Runner transport: ${label} — applies from the next run`);
  });

  it('with no argument shows the setting and the usage, changing nothing', async () => {
    const api = fakeApi({ runnerTransport: 'structured' });
    const out = await printed(() => handleTransport([], api as unknown as ApiClient));
    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(out).toContain('Runner transport: structured');
    expect(out).toContain('Usage: ordewell transport [terminal|structured]');
  });
});
