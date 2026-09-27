import { dependentsOf } from '@ordewell/core/plan-utils';
import { findTask, type ModelView, type TaskView, type TuiState } from '../state';
import { assignedModelFor, effortsForTask, modesForTask, runnerAccepts } from '../taskAssignment';
import { picker, pickerItemsFor } from './pickers';
import { fail, step, withSession, type Step } from './shared';

export function openTaskRunnerPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not run on an executor, so they have no runner.');
  const action = { kind: 'set-task-runner' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Runner · #${task.order} ${task.title}`, pickerItemsFor(state, action), action, {
          hint: 'Changing the runner re-picks this task model, effort and mode for it.',
        }),
      },
    },
  );
}

/**
 * Names the dependents rather than counting them: the removal rewrites those
 * tasks' dependency lists, and a bare "Remove task?" would hide that.
 */
export function confirmRemoveTask(state: TuiState, task: TaskView): Step {
  const dependents = dependentsOf(state.tasks, task.id);
  const named = dependents.map((t) => `#${t.order} ${t.title}`).join(', ');
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `Remove #${task.order} ${task.title}?`,
      message: dependents.length > 0
        ? `${dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`} on it and will lose that dependency: ${named}.`
        : 'This cannot be undone.',
      action: { kind: 'remove-task', taskId: task.id },
    },
  });
}

export function openTaskDepsPicker(state: TuiState, task: TaskView): Step {
  const action = { kind: 'set-task-deps' as const, taskId: task.id };
  const items = pickerItemsFor(state, action);
  if (items.length === 0) return fail(state, `Nothing runs before #${task.order}, so it has no possible dependencies.`);
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker(`Depends on · #${task.order} ${task.title}`, items, action, {
        hint: 'Only tasks earlier in the plan can be dependencies.',
        multi: true,
        chosen: task.dependencies.filter((id) => items.some((i) => i.id === id)),
      }),
    },
  });
}

export function openTaskModePicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have an executor mode.');
  const modes = modesForTask(state.modesByRunner, task);
  if (modes.length === 0) {
    return fail(state, `${task.assignedRunner ?? 'This runner'} declares no modes.`);
  }
  const action = { kind: 'set-task-mode' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Mode · #${task.order}`, pickerItemsFor(state, action), action, {
          hint: `Modes declared by ${task.assignedRunner}.`,
        }),
      },
    },
  );
}

export function openTaskModelPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have an executor model.');
  const action = { kind: 'set-task-model' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Model · #${task.order} ${task.title}`, pickerItemsFor(state, action), action, {
          hint: task.assignedRunner
            ? `Showing models discovered for ${task.assignedRunner}.`
            : 'Choose the model this task will run with.',
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

export function openTaskEffortPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have a thinking effort.');
  if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
  const action = { kind: 'set-task-effort' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Thinking effort · #${task.order}`, pickerItemsFor(state, action), action, {
          hint: `${task.assignedModel.modelLabel} · choose runner default or a supported effort`,
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

export function assignTaskModel(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  model: ModelView,
): Step {
  const assignedModel = assignedModelFor(model, task.assignedModel?.thinkingEffort);
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    // JSON drops `undefined`; null is intentional here so changing models can
    // also clear a stale legacy top-level effort on the persisted task.
    changes: { assignedModel, thinkingEffort: assignedModel.thinkingEffort ?? null },
    message: `Task #${task.order} model set to ${model.label}.`,
  }]);
}

/**
 * Sends only the runner. The daemon owns the retarget (Session.setTaskRunner):
 * it re-derives model, effort and mode from the new runner's catalog, and the
 * refreshed plan comes back through the usual plan refresh. Picking a model
 * here would race that and could name one the runner cannot spawn.
 */
export function assignTaskRunner(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  runner: string,
  runnerLabel: string,
): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { assignedRunner: runner },
    message: `Task #${task.order} runner set to ${runnerLabel}.`,
  }]);
}

export function assignTaskMode(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  mode: string,
  modeLabel: string,
): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { taskMode: mode },
    message: `Task #${task.order} mode set to ${modeLabel}.`,
  }]);
}

export function assignTaskEffort(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  thinkingEffort: string | undefined,
): Step {
  const assignedModel = task.assignedModel
    ? { ...task.assignedModel, thinkingEffort }
    : undefined;
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { assignedModel, thinkingEffort: thinkingEffort ?? null },
    message: `Task #${task.order} thinking effort set to ${thinkingEffort ?? 'runner default'}.`,
  }]);
}

export function taskModelCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskModelPicker(state, task);
    const model = state.models.find((candidate) => candidate.id === args[1]) ?? {
      id: args[1],
      label: args[1],
      provider: '',
      variants: [],
    };
    if (!runnerAccepts(task, model)) {
      return fail(state, `${model.label} was not discovered for ${task.assignedRunner}.`);
    }
    return assignTaskModel(state, sessionId, task, model);
  });
}

export function taskRunnerCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskRunnerPicker(state, task);
    const runner = state.runners.find((candidate) => candidate.id === args[1]);
    if (!runner) return fail(state, `Unknown runner "${args[1]}".`);
    return assignTaskRunner(state, sessionId, task, runner.id, runner.name);
  });
}

export function taskModeCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskModePicker(state, task);
    const mode = modesForTask(state.modesByRunner, task).find((candidate) => candidate.id === args[1]);
    if (!mode) return fail(state, `Unsupported mode "${args[1]}" for ${task.assignedRunner}.`);
    return assignTaskMode(state, sessionId, task, mode.id, mode.label);
  });
}

export function taskEffortCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskEffortPicker(state, task);
    if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
    const effort = args[1].toLowerCase();
    const value = effort === 'default' || effort === 'none' ? undefined : args[1];
    const supported = effortsForTask(state.models, task);
    if (value && supported.length > 0 && !supported.some((variant) => variant.id === value)) {
      return fail(state, `Unsupported effort "${value}" for ${task.assignedModel.modelLabel}.`);
    }
    return assignTaskEffort(state, sessionId, task, value);
  });
}

export function addTask(state: TuiState, title: string): Step {
  if (!state.sessionId) {
    return fail(state, 'No active plan to add a task to — describe a goal first, then /add-task <title>.');
  }
  if (!title) {
    return step({
      ...state,
      overlay: { kind: 'prompt', title: 'New task title', value: '', action: { kind: 'add-task' } },
    });
  }
  return step(state, [{ type: 'addTask', sessionId: state.sessionId, title }]);
}

export function taskCommand(
  state: TuiState,
  token: string | undefined,
  run: (sessionId: string, taskId: string) => Step,
): Step {
  return withSession(state, (sessionId) => {
    if (!token) return fail(state, 'Which task? Pass a task id or its number in the plan.');
    const taskId = resolveTaskId(state, token);
    if (!taskId) return fail(state, `No task matching "${token}" in the current plan.`);
    return run(sessionId, taskId);
  });
}

/** Users refer to tasks by the number shown in the plan pane as often as by id. */
export function resolveTaskId(state: TuiState, token: string): string | null {
  const byId = findTask(state.tasks, token);
  if (byId) return byId.id;

  const order = Number(token);
  if (Number.isInteger(order)) {
    const byOrder = state.tasks.find((t) => t.order === order);
    if (byOrder) return byOrder.id;
  }
  return null;
}
