import { TaskModeUnsupportedError, type AgentProcessDeps, type TaskModeAgentAdapter } from './AgentAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';

/**
 * The runners with a task-mode connector (ADR-0018, S3). Codex (#54) joins
 * when its adapter learns task mode; until then its adapter refuses it and
 * its tasks run on the terminal transport.
 */
const TASK_MODE_ADAPTERS: Record<string, (deps: AgentProcessDeps) => TaskModeAgentAdapter> = {
  'claude-code': (deps) => new ClaudeCodeAdapter(deps),
  opencode: (deps) => new OpenCodeAdapter(deps),
};

/** Whether a runner's tasks can run on the structured transport. */
export function supportsTaskMode(runner: string): boolean {
  return Object.hasOwn(TASK_MODE_ADAPTERS, runner);
}

/** The adapter that drives one task. Throws {@link TaskModeUnsupportedError} for a runner without a connector. */
export function createTaskAdapter(runner: string, deps: AgentProcessDeps): TaskModeAgentAdapter {
  if (!supportsTaskMode(runner)) throw new TaskModeUnsupportedError(runner);
  return TASK_MODE_ADAPTERS[runner](deps);
}
