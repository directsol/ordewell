import * as vscode from 'vscode';
import {
  Session, LegacyPlanState, Task, flattenTasks, RunnerId, DiscoveredModel, enabledRunners,
  validateModifiedPlan, warningsText, saveState, ModelResolver, RunnerRegistry, isCliProvider,
  type INotification,
} from '@ordewell/core';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import { VsCodeTerminalRunner } from '../adapters/VsCodeTerminalRunner';
import { handleIsolationBlocked, handleIsolationHandoff } from './isolation';

export interface PlanManagerDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  modelResolver: ModelResolver;
  pluginRegistry: RunnerRegistry;
  config: VsCodeConfig;
  fsAdapter: VsCodeFileSystem;
  terminalRunner: VsCodeTerminalRunner;
  notifications: INotification;
  settingsService: { getTdd(): boolean; };
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  isGeneratingPlan: () => boolean;
  setGeneratingPlan: (v: boolean) => void;
  getResearchAbort: () => AbortController | null;
  setResearchAbort: (c: AbortController | null) => void;
  persistState: () => void;
  saveCurrentSession: () => void;
  log: (msg: string) => void;
}

export function findTask(plan: LegacyPlanState, id: string): Task | undefined {
  return flattenTasks(plan.tasks).find((t) => t.id === id);
}

export async function discoverModelsForPlan(deps: PlanManagerDeps): Promise<Partial<Record<RunnerId, DiscoveredModel[]>>> {
  return deps.modelResolver.modelsForRunners(enabledRunners(deps.config));
}

export function resolveRunnerSet(
  deps: PlanManagerDeps,
  pendingRunners?: RunnerId[],
  currentPlanRunners?: RunnerId[],
): RunnerId[] | null {
  const enabled = enabledRunners(deps.config).filter((r) => deps.pluginRegistry.get(r));
  if (enabled.length === 0) {
    deps.chatProvider.showError('No runner is enabled. Toggle runners in the chat header first.');
    return null;
  }
  if (pendingRunners && pendingRunners.length > 0) {
    const valid = pendingRunners.filter((r) => enabled.includes(r));
    if (valid.length > 0) return valid;
  }
  // Fall back to the current plan's runners (e.g. regeneration) rather than
  // expanding to ALL enabled runners — the user's prior selection should
  // persist, not be silently widened to include a runner they toggled off.
  if (currentPlanRunners && currentPlanRunners.length > 0) {
    const valid = currentPlanRunners.filter((r) => enabled.includes(r));
    if (valid.length > 0) return valid;
  }
  return enabled;
}

export function finishPlannerTurn(
  plan: LegacyPlanState,
  currentGoal: string,
  deps: PlanManagerDeps,
  opts?: { planChanged?: boolean },
): void {
  const planChanged = opts?.planChanged ?? true;
  if (plan.tasks.length > 0) {
    if (planChanged) {
      deps.chatProvider.planGenerated(plan);
    }
    deps.chatProvider.setGoal(currentGoal);
  } else {
    deps.chatProvider.setState('planDraft');
  }
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  deps.saveCurrentSession();
}

export function reportPlannerError(err: unknown, deps: PlanManagerDeps): void {
  const isAbort = err instanceof Error && (
    err.name === 'AbortError' ||
    err.name === 'APIUserAbortError' ||
    /aborted/i.test(err.message)
  );
  // The stop already ended the turn on screen.
  if (isAbort) return;
  const message = err instanceof Error ? err.message : String(err);
  deps.chatProvider.showError(`Planner failed: ${message}`);
}

/**
 * What the selected planner still needs before it can plan, or null when it is
 * ready. There are two ways in (ADR-0009), and only one of them involves a
 * credential: a harness planner drives a coding agent already installed on the
 * machine, authenticated by the user's own subscription, so demanding an API
 * key of it turns a working setup into a wall — the exact failure reported when
 * Claude Code was the selected planner. Its model is optional too: an unset id
 * means "the agent's own default" (`CliAgentAiService.plannerModel`), which is
 * what `applyPlanner` deliberately leaves behind when it clears a model id the
 * new backend cannot serve.
 */
export function plannerPreflightError(config: PlanManagerDeps['config']): string | null {
  if (isCliProvider(config.aiProvider)) return null;
  if (!config.apiKey) {
    return 'API key not configured. Run "Ordewell: Configure API Key" to set it.';
  }
  if (!config.planningModel) {
    return 'No orchestrator model selected. Type /model set to pick one first.';
  }
  return null;
}

/** Reports the preflight failure to the chat and returns false when not ready. */
function plannerReady(deps: PlanManagerDeps): boolean {
  const error = plannerPreflightError(deps.config);
  if (!error) return true;
  deps.chatProvider.showError(error);
  return false;
}

export async function handleStartPlanning(
  userDescription: string,
  deps: PlanManagerDeps,
  pendingRunners?: RunnerId[],
): Promise<void> {
  if (!plannerReady(deps)) return;
  const runners = resolveRunnerSet(deps, pendingRunners, deps.getCurrentPlan().runners);
  if (!runners) {
    return;
  }
  try {
    deps.setGeneratingPlan(true);
    deps.setResearchAbort(new AbortController());

    const plan = await deps.session.startPlanning(userDescription, runners, {
      signal: deps.getResearchAbort()?.signal,
    });

    deps.setCurrentGoal(userDescription);
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, userDescription, deps);
  } catch (err) {
    reportPlannerError(err, deps);
  } finally {
    deps.setGeneratingPlan(false);
    deps.setResearchAbort(null);
  }
}

export async function handleContinueConversation(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  try {
    deps.setGeneratingPlan(true);
    deps.setResearchAbort(new AbortController());

    const priorPlan = deps.getCurrentPlan();
    const priorTasksKey = JSON.stringify(priorPlan.tasks);
    const plan = await deps.session.continueConversation(text, {
      signal: deps.getResearchAbort()?.signal,
    });

    const planChanged = JSON.stringify(plan.tasks) !== priorTasksKey;
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, deps.getCurrentGoal(), deps, { planChanged });
  } catch (err) {
    reportPlannerError(err, deps);
  } finally {
    deps.setGeneratingPlan(false);
    deps.setResearchAbort(null);
  }
}

/**
 * Planner-driven merge (issue #18): route a merge request through the planner
 * conversation loop so the LLM produces the combined task, validated atomically
 * via applyTaskOps with corrective retries — not a mechanical client-side stub.
 * A pre-flight compatibility failure (canMergeTasks) throws before any LLM call.
 */
export async function handleMergePlan(taskIds: string[], deps: PlanManagerDeps): Promise<void> {
  try {
    deps.setGeneratingPlan(true);
    deps.setResearchAbort(new AbortController());

    const priorPlan = deps.getCurrentPlan();
    const priorTasksKey = JSON.stringify(priorPlan.tasks);
    const plan = await deps.session.requestMerge(taskIds, {
      signal: deps.getResearchAbort()?.signal,
    });

    const planChanged = JSON.stringify(plan.tasks) !== priorTasksKey;
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, deps.getCurrentGoal(), deps, { planChanged });
  } catch (err) {
    reportPlannerError(err, deps);
  } finally {
    deps.setGeneratingPlan(false);
    deps.setResearchAbort(null);
  }
}

/**
 * Planner-driven split (issue #18): ask the planner LLM to decompose one task
 * into a sequence of smaller tasks. Same conversation-loop / repair path as
 * merge; the model generates the breakdown (no manual per-task specs).
 */
export async function handleSplitPlan(taskId: string, deps: PlanManagerDeps): Promise<void> {
  try {
    deps.setGeneratingPlan(true);
    deps.setResearchAbort(new AbortController());

    const priorPlan = deps.getCurrentPlan();
    const priorTasksKey = JSON.stringify(priorPlan.tasks);
    const plan = await deps.session.requestSplit(taskId, {
      signal: deps.getResearchAbort()?.signal,
    });

    const planChanged = JSON.stringify(plan.tasks) !== priorTasksKey;
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, deps.getCurrentGoal(), deps, { planChanged });
  } catch (err) {
    reportPlannerError(err, deps);
  } finally {
    deps.setGeneratingPlan(false);
    deps.setResearchAbort(null);
  }
}

export async function handleModifyPlan(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  if (!plannerReady(deps)) return;
  try {
    await deps.session.modifyPlan(text);

    const plan = deps.getCurrentPlan();
    const warnings = validateModifiedPlan(plan.tasks, deps.session.planTasks);
    const warningMsg = warningsText(warnings);

    if (warningMsg) {
      deps.chatProvider.showWarnings(warningMsg, deps.session.planTasks);
      return;
    }

    if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
    deps.chatProvider.planGenerated(deps.getCurrentPlan());
    saveState(deps.getCurrentPlan(), deps.fsAdapter.getWorkspaceRoot());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.chatProvider.showError(`Failed to modify plan: ${message}`);
  }
}

export async function handleApprovePlan(deps: PlanManagerDeps): Promise<void> {
  deps.log('=== handleApprovePlan START ===');
  if (deps.session.isExecuting) {
    deps.log('Stopping existing orchestrator run before approving new plan');
    deps.session.stopExecution();
    deps.terminalRunner.stopAll();
  }
  const plan = deps.getCurrentPlan();
  plan.status = 'approved';
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  const allTasks = flattenTasks(plan.tasks);
  for (const task of allTasks) { if (task.status !== 'completed') task.status = 'approved'; }
  deps.session.loadPlan(plan, deps.getCurrentGoal(), '');
  deps.chatProvider.planApproved();
  deps.chatProvider.clearIsolationHandoff();
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  deps.saveCurrentSession();
  try {
    deps.log('Calling session.executePlan()...');
    await deps.session.executePlan();
    deps.log(`executePlan() returned. isRunning=${deps.session.isExecuting}, status=${deps.session.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`Orchestrator start failed: ${msg}`);
    vscode.window.showErrorMessage(`Failed to start execution: ${msg}`);
  }
  deps.log('=== handleApprovePlan END ===');
}

/**
 * A restored plan can exist on the host before the Session has adopted it
 * (legacy globalState, defensive paths). Adopt it so the conversational loop
 * has plan state to work with — without forking a new session file.
 */
function ensureSessionPlan(deps: PlanManagerDeps): void {
  if (deps.session.planState) return;
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0 && !(plan.conversationHistory && plan.conversationHistory.length > 0)) return;
  try {
    deps.session.loadPlan(plan, deps.getCurrentGoal(), deps.fsAdapter.getWorkspaceRoot(), { persist: false });
  } catch (err) {
    deps.log(`ensureSessionPlan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleSendMessage(
  text: string,
  deps: PlanManagerDeps,
  pendingRunners: RunnerId[] | undefined,
  setPendingRunners: (r: RunnerId[] | undefined) => void,
): Promise<void> {
  if (!plannerReady(deps)) return;

  setPendingRunners(pendingRunners);

  const plan = deps.getCurrentPlan();
  const hasDialogue = (plan.conversationHistory?.length ?? 0) > 0;

  // Unified loop (post-plan chat included): the model decides per turn whether
  // to reply, emit targeted task edits, or re-plan. While a runner is live the
  // Session answers questions live and queues structural edits for the next
  // batch boundary. handleStartPlanning remains only for a truly fresh session.
  if (deps.session.isExecuting || plan.tasks.length > 0 || hasDialogue || deps.session.isConversationActive) {
    ensureSessionPlan(deps);
    await handleContinueConversation(text, deps);
    // Only a live runner can queue an edit — an armed-but-idle scheduler applies
    // it, so the strip would announce a queue that never forms.
    if (deps.session.hasLiveWork) deps.chatProvider.showQueueStatus(deps.session.getQueuedMessages());
  } else {
    await handleStartPlanning(text, deps, pendingRunners);
  }
}

export async function handleSystemCommand(
  command: string,
  taskId: string,
  deps: PlanManagerDeps,
): Promise<void> {
  switch (command) {
    case 'cancel':
      await deps.session.cancelTask(taskId);
      break;
    case 'skip':
    case 'markComplete':
      await deps.session.markTaskComplete(taskId);
      break;
    case 'markIncomplete':
      await deps.session.markTaskIncomplete(taskId);
      break;
    case 'forceStart':
      deps.chatProvider.clearIsolationHandoff();
      await deps.session.forceStartTask(taskId);
      break;
    case 'runTask':
      deps.chatProvider.clearIsolationHandoff();
      await deps.session.runTask(taskId);
      break;
    case 'executePlan':
      await handleApprovePlan(deps);
      break;
    case 'stopExecution':
      deps.session.stopExecution();
      deps.terminalRunner.stopAll();
      deps.chatProvider.setState('planDraft');
      break;
  }
  deps.chatProvider.showPlan(deps.getCurrentPlan());
  deps.persistState();
}

export function handleSessionMessage(
  msg: import('@ordewell/core').SessionMessage,
  deps: PlanManagerDeps,
): void {
  deps.chatProvider.conversation.receive(msg);
  if (msg.type === 'approval_request') {
    // The chat card is the question now, so make sure the user is looking at
    // it. Nothing blocks here: the session's research loop awaits the answer on
    // the broadcast seam, and the webview answers through `resolveApproval`.
    deps.chatProvider.reveal();
    return;
  }
  switch (msg.type) {
    case 'checkpoint':
      deps.chatProvider.showCheckpoint(msg.taskId, msg.taskTitle, msg.summary);
      break;
    // Runner chatter was dropped here entirely, so a task that failed mid-run
    // showed a red card and nothing else. The webview keeps only the tail.
    case 'task_output':
      deps.chatProvider.sendTaskOutput(msg.taskId, msg.text);
      break;
    case 'status_update': {
      const plan = deps.getCurrentPlan();
      plan.status = deps.session.isExecuting
        ? 'running'
        : deps.session.status === 'completed'
          ? 'completed'
          : 'draft';
      for (const task of msg.tasks) {
        deps.chatProvider.sendTaskIdle(task.id, task.idleSince ?? null);
        // A shared-root plan sends none; only a task with isolated work reports
        // it, so the cards stay quiet unless isolation has something to say.
        if (task.isolation) deps.chatProvider.sendTaskIsolation(task.id, task.isolation);
      }
      deps.chatProvider.showPlan(plan);
      break;
    }
    case 'queue_ready':
      processQueuedBatched(deps);
      break;
    case 'execution_complete': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      deps.persistState();
      break;
    }
    case 'execution_stopped': {
      const plan = deps.getCurrentPlan();
      plan.status = 'draft';
      deps.chatProvider.showPlan(plan);
      deps.persistState();
      break;
    }
    case 'review_needed': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      break;
    }
    // A dirty tree parked the run. The user's way out is a real modal: stash
    // and continue, run in the shared root this once, or cancel.
    case 'isolation_blocked':
      handleIsolationBlocked(msg.message, deps);
      break;
    // An isolated run settled: the branch its work landed on and what landed.
    // Sent before `execution_complete`; the webview shows the handoff card.
    case 'isolation_handoff':
      handleIsolationHandoff({ repos: msg.repos, landed: msg.landed }, deps);
      break;
    // Drawn by the conversation view above, or not by this surface at all.
    // Named so a new SessionMessage variant fails to compile until someone
    // decides what it means here.
    case 'planner_message':
    case 'plan_token':
    case 'planner_text_delta':
    case 'plan_thinking':
    case 'planner_thinking_delta':
    case 'planner_liveness':
    case 'research_step':
    case 'research_step_done':
    case 'plan_generated':
    case 'review_approved':
    case 'task_updated':
    case 'task_started':
    case 'planner_turn_started':
    case 'planner_turn_ended':
    case 'planner_text_retracted':
    case 'planner_usage':
    case 'subagent_started':
    case 'subagent_finished':
    case 'approval_settled':
    case 'approval_decided':
      break;
    // What Merge all did, whether this host asked for it or another surface did.
    // The webview shows a blocked or part-landed group per repo; core's notices
    // already told the user in prose. A full merge is the end of the run: core
    // has cleared it up, so there is no card left to show.
    case 'isolation_merge':
      if (msg.result.outcome === 'merged') deps.chatProvider.clearIsolationHandoff();
      else deps.chatProvider.showIsolationMergeResult(msg.result);
      break;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}

export async function processQueuedBatched(deps: PlanManagerDeps): Promise<void> {
  await deps.session.processQueuedMessages();
  // The batch consumed the queue, so the webview's strip must empty with it —
  // otherwise a withdrawn or applied prompt lingers as if still waiting.
  deps.chatProvider.showQueueStatus([]);
  deps.chatProvider.showPlan(deps.getCurrentPlan());
  deps.persistState();
}
