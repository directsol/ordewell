import { EventEmitter } from 'events';
import { ITerminalRunner, ITerminalSession } from '../interfaces/ITerminalRunner';

/** One source for the spawn options, so a runner built on this base cannot drift from the interface. */
export type RunnerSpawnOptions = Parameters<ITerminalRunner['spawn']>[0];

export abstract class AbstractTerminalSession implements ITerminalSession {
  public id: string;
  public taskId: string;
  protected exited = false;
  protected outputEmitter = new EventEmitter();
  protected exitEmitter = new EventEmitter();

  constructor(id: string, taskId: string) {
    this.id = id;
    this.taskId = taskId;
  }

  protected baseHandleExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitEmitter.emit('exit', code);
  }

  onOutput(callback: (text: string) => void): void {
    this.outputEmitter.on('output', callback);
  }

  onExit(callback: (code: number) => void): void {
    this.exitEmitter.on('exit', callback);
  }

  abstract kill(): void;
  abstract getOutput(): string;
  abstract write(text: string): void;
}

export abstract class AbstractRunner<S extends ITerminalSession> implements ITerminalRunner {
  protected sessions: Map<string, S> = new Map();

  get activeCount(): number { return this.sessions.size; }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.kill();
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const [, session] of this.sessions) {
      session.kill();
    }
    this.sessions.clear();
  }

  protected registerSession(id: string, session: S): void {
    this.sessions.set(id, session);
    // A replaced session's late exit must not unregister its successor.
    session.onExit(() => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
  }

  abstract spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession>;
}
