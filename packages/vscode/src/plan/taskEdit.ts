import { dependentsOf, flattenTasks } from '@ordewell/core';
import type { Task } from '@ordewell/core';
import type { TaskDraft } from '../shared/protocol';

/**
 * What to ask before removing a task.
 *
 * Dependents are named, not just counted, because the removal rewrites them:
 * `removeTaskFromPlan` strips the dead id from every dependency list, so a user
 * who is not told loses edges they never edited.
 */
export function removalPrompt(tasks: readonly Task[], taskId: string): string {
  const all = flattenTasks(tasks);
  const title = all.find((t) => t.id === taskId)?.title;
  const question = title ? `Remove "${title}"?` : 'Remove this task?';
  const dependents = dependentsOf(all, taskId);
  if (dependents.length === 0) return question;

  const named = dependents.map((t) => `#${t.order} ${t.title}`).join(', ');
  const subject = dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`;
  return `${question}\n\n${subject} on it and will lose that dependency: ${named}.`;
}

/**
 * A hand-written task from the webview's add form. Only what a user can
 * actually fill in is read across — everything else (id, status, completion
 * marker, and any assignment the form left blank) is the session's to derive.
 */
export function taskFromDraft(draft: TaskDraft): Partial<Task> | null {
  const title = draft.title.trim();
  if (!title) return null;
  return {
    title,
    description: title,
    prompt: draft.prompt?.trim() ? draft.prompt : title,
    type: 'ai',
    dependencies: draft.dependencies.map(String),
    assignedRunner: draft.assignedRunner,
    assignedModel: draft.assignedModel,
    taskMode: draft.taskMode,
  };
}
