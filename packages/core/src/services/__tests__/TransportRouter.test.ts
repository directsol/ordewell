import { describe, it, expect, vi } from 'vitest';
import { TransportRouter, routeTransport } from '../TransportRouter';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { FakeStructuredSession, FakeTerminalSession } from '../../testing';
import type { ITerminalRunner, ITerminalSession } from '../../interfaces/ITerminalRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

const registry = new RunnerRegistry();

function fakeRunner(make: (n: number, taskId: string) => ITerminalSession) {
  let count = 0;
  return {
    spawn: vi.fn(async (opts: RunnerSpawnOptions) => make(++count, opts.taskId)),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies ITerminalRunner;
}

function routed() {
  const terminal = fakeRunner((n, taskId) => new FakeTerminalSession(`term-${n}`, taskId));
  const structured = fakeRunner((n, taskId) => new FakeStructuredSession(`struct-${n}`, taskId));
  return { terminal, structured, router: new TransportRouter({ terminal, structured }) };
}

function spawnOptions(overrides: Partial<RunnerSpawnOptions> = {}): RunnerSpawnOptions {
  return { taskId: 't1', runner: 'claude-code', prompt: 'do it', cwd: '/repo', registry, ...overrides };
}

describe('routeTransport', () => {
  it('runs a structured request on the structured transport when the runner has a connector', () => {
    expect(routeTransport('structured', 'claude-code', registry)).toEqual({ transport: 'structured' });
  });

  it('falls back to the terminal for a runner without one, naming it', () => {
    expect(routeTransport('structured', 'codex', registry)).toEqual({ transport: 'terminal', fallback: 'no structured connector for Codex yet' });
    expect(routeTransport('structured', 'opencode', registry)).toEqual({ transport: 'terminal', fallback: 'no structured connector for OpenCode yet' });
  });

  it('names an unregistered runner by its id', () => {
    expect(routeTransport('structured', 'my-plugin', null).fallback).toBe('no structured connector for my-plugin yet');
  });

  it('has nothing to say about a plan that asked for the terminal', () => {
    expect(routeTransport('terminal', 'codex', registry)).toEqual({ transport: 'terminal' });
    expect(routeTransport(undefined, 'claude-code', registry)).toEqual({ transport: 'terminal' });
  });
});

describe('TransportRouter', () => {
  it('spawns a structured Claude Code task on the structured runner', async () => {
    const { router, terminal, structured } = routed();
    const session = await router.spawn(spawnOptions({ transport: 'structured' }));

    expect(session.id).toBe('struct-1');
    expect(structured.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', runner: 'claude-code' }));
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it('keeps a terminal plan on the terminal runner, whatever its runner supports', async () => {
    const { router, terminal, structured } = routed();
    expect((await router.spawn(spawnOptions())).id).toBe('term-1');
    expect((await router.spawn(spawnOptions({ transport: 'terminal' }))).id).toBe('term-2');
    expect(terminal.spawn).toHaveBeenCalledTimes(2);
    expect(structured.spawn).not.toHaveBeenCalled();
  });

  it('falls back to the terminal runner for a runner with no connector', async () => {
    const { router, terminal, structured } = routed();
    const session = await router.spawn(spawnOptions({ runner: 'codex', transport: 'structured' }));

    expect(session.id).toBe('term-1');
    expect(terminal.spawn).toHaveBeenCalledOnce();
    expect(structured.spawn).not.toHaveBeenCalled();
  });

  it('stops each session on the runner that spawned it', async () => {
    const { router, terminal, structured } = routed();
    const s = await router.spawn(spawnOptions({ transport: 'structured' }));
    const t = await router.spawn(spawnOptions({ taskId: 't2', runner: 'codex', transport: 'structured' }));

    router.stop(s.id);
    router.stop(t.id);

    expect(structured.stop).toHaveBeenCalledWith('struct-1');
    expect(terminal.stop).toHaveBeenCalledWith('term-1');
    expect(structured.stop).toHaveBeenCalledOnce();
    expect(terminal.stop).toHaveBeenCalledOnce();
  });

  it('keeps routing a structured id to its runner after the session exits', async () => {
    const { router, terminal, structured } = routed();
    const s = await router.spawn(spawnOptions({ transport: 'structured' })) as FakeStructuredSession;
    s.emitExit(0);

    router.stop(s.id);

    expect(structured.stop).toHaveBeenCalledWith('struct-1');
    expect(terminal.stop).not.toHaveBeenCalled();
  });

  it('stops both runners and counts both', () => {
    const { router, terminal, structured } = routed();
    terminal.activeCount = 2;
    structured.activeCount = 1;

    expect(router.activeCount).toBe(3);
    router.stopAll();
    expect(terminal.stopAll).toHaveBeenCalledOnce();
    expect(structured.stopAll).toHaveBeenCalledOnce();
  });
});
