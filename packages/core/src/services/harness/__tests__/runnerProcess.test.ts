import { describe, it, expect, afterEach, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../ClaudeCodeAdapter';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentAdapter, AgentProcessDeps, TaskStartOptions } from '../AgentAdapter';
import { fakeSpawn } from '../../__tests__/harnessTestKit';

/**
 * What the harness adapters owe the runner process they start, whatever its
 * protocol: a write racing its death must not take the host down with it,
 * and the host's own debugging and nesting variables stay with the host.
 */

/** Just enough of `opencode serve` for a planner session to start. */
const serveFetch = (async (input: unknown, init?: RequestInit) => {
  if (init?.method !== 'POST' || !String(input).endsWith('/session')) throw new Error(`unrouted request: ${String(input)}`);
  return { ok: true, status: 200, json: async () => ({ id: 'ses_1' }) } as unknown as Response;
}) as unknown as typeof fetch;

function deps(spawned: ReturnType<typeof fakeSpawn>, workspace: Record<string, string> = {}, envs: NodeJS.ProcessEnv[] = []): AgentProcessDeps {
  return {
    spawn: (command, args, options) => { envs.push(options.env); return spawned.spawn(command, args, options); },
    fetch: serveFetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => workspace,
  };
}

async function startOpenCode(spawned: ReturnType<typeof fakeSpawn>, processDeps = deps(spawned)): Promise<OpenCodeAdapter> {
  const adapter = new OpenCodeAdapter(processDeps);
  const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' });
  for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
  spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
  await started;
  return adapter;
}

const taskStart: TaskStartOptions = { kind: 'task', cwd: '/repo', mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} } };

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('a write to a dying runner', () => {
  it('does not throw from the stdio adapter\'s stdin', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    await adapter.start(taskStart);
    expect(() => spawned.processes[0].stdin!.emit('error', epipe())).not.toThrow();
    adapter.dispose();
  });

  it('does not throw from the OpenCode server\'s stdin', async () => {
    const spawned = fakeSpawn([]);
    const adapter = await startOpenCode(spawned);
    expect(() => spawned.processes[0].stdin!.emit('error', epipe())).not.toThrow();
    adapter.dispose();
  });
});

describe('the environment a runner starts under', () => {
  const HOST_ONLY = ['CLAUDECODE', 'NODE_OPTIONS', 'NODE_INSPECT', 'NODE_DEBUG'];

  afterEach(() => { vi.unstubAllEnvs(); });

  function hostLaunchedFromClaudeCode(): void {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('NODE_OPTIONS', '--inspect');
    vi.stubEnv('NODE_INSPECT', '1');
    vi.stubEnv('NODE_DEBUG', 'net');
    vi.stubEnv('ORDEWELL_TEST_KEPT', 'yes');
  }

  const adapters: Array<[string, (spawned: ReturnType<typeof fakeSpawn>, processDeps: AgentProcessDeps) => Promise<AgentAdapter>]> = [
    ['the stdio adapter', async (_spawned, processDeps) => {
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart);
      return adapter;
    }],
    ['the OpenCode adapter', startOpenCode],
  ];

  it.each(adapters)('%s leaves the host\'s nesting and debugging variables behind', async (_label, start) => {
    hostLaunchedFromClaudeCode();
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const adapter = await start(spawned, deps(spawned, {}, envs));
    for (const name of HOST_ONLY) expect(envs[0]).not.toHaveProperty(name);
    expect(envs[0].ORDEWELL_TEST_KEPT).toBe('yes');
    adapter.dispose();
  });

  it.each(adapters)('%s still passes one the workspace sets on purpose (ADR-0016)', async (_label, start) => {
    hostLaunchedFromClaudeCode();
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const adapter = await start(spawned, deps(spawned, { NODE_OPTIONS: '--max-old-space-size=8192' }, envs));
    expect(envs[0].NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(envs[0]).not.toHaveProperty('CLAUDECODE');
    adapter.dispose();
  });
});
