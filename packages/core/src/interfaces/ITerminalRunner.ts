export interface ITerminalSession {
  id: string;
  taskId: string;
  onOutput(callback: (text: string) => void): void;
  onExit(callback: (code: number) => void): void;
  kill(): void;
  getOutput(): string;
  write(text: string): void;
  /**
   * True when the session runs the agent as a raw-mode TUI (a real PTY for the
   * VS Code terminal, a tmux window). Such a surface submits an input line on
   * the Enter keystroke (`\r`), so a synchronized resume token terminated with
   * `\n` only types the line and never sends it. A line-oriented piped session
   * (`defaultInteractive = false`) leaves this false and accepts `\n`.
   */
  readonly interactive?: boolean;
  /**
   * Optional transport-level control channel: PTY resize requests for a session
   * whose runner renders a TUI. Absent on transports without a resizable PTY
   * (a plain piped subprocess); surfaces must feature-detect before calling.
   */
  writeControl?(text: string): void;
}

import type { RunnerRegistry } from '../plugins/RunnerRegistry';

export interface ITerminalRunner {
  spawn(opts: {
    taskId: string;
    runner: string;
    prompt: string;
    modelId?: string;
    thinkingEffort?: string;
    modelVariants?: string[];
    mode?: string;
    headless?: boolean;
    cwd: string;
    registry?: RunnerRegistry;
    /** Task order and title — surfaces use these to label task_started/output events. */
    order?: number;
    title?: string;
    /**
     * The owning plan session. Task ids are only unique within one plan, so
     * transports that key OS resources by task (tmux windows, log files) need
     * this to keep two plans' identically named tasks apart.
     */
    planSessionId?: string;
    /**
     * The workspace's own variables (ADR-0016), under the runner's: a
     * manifest's env still wins over them.
     */
    env?: Record<string, string>;
  }): Promise<ITerminalSession>;

  stop(sessionId: string): void;
  stopAll(): void;
  activeCount: number;
}
