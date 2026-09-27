import type {
  AiProvider, DisplayBlock, DiscoveredModel, IsolationHandoff, IsolationMergeResult, LegacyPlanState, PromptHold, RunnerId,
  Task, TaskIsolation, TaskStatus,
} from '@ordewell/core';

/*
 * The messages between the extension host and the chat webview, both ways.
 * Types only: the host (tsup) and the webview (Vite) each compile this file,
 * so neither can drift from what the other sends.
 */

/** One selectable planner backend, with the reason it can't be picked when it can't. */
export interface PlannerBackend {
  id: string;
  label: string;
  kind: 'harness' | 'vendor';
  /** Harness planners only: the runner whose catalog supplies this planner's models. */
  runner?: string;
  usable: boolean;
  reason?: string;
}

export interface RunnerMeta {
  id: string;
  displayName: string;
  enabled: boolean;
}

export interface RunnerModeMeta {
  id: string;
  label: string;
  description: string;
  cliValue?: string;
  autonomous?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  apiProvider?: AiProvider;
  description?: string;
  pricing?: string;
}

export type ChatState = 'empty' | 'researching' | 'planDraft' | 'approved' | 'error';

export type SystemCommand = 'cancel' | 'skip' | 'forceStart' | 'runTask' | 'markComplete' | 'markIncomplete' | 'stopExecution' | 'executePlan';

export type IsolationActionKind = 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict';

/**
 * What changed in the host's conversation view since the last patch: the ids
 * of every block in order, and the blocks that are new or changed. A block
 * absent from `order` is gone. See `ConversationViewHost` for why the host
 * sends patches rather than the whole view.
 */
export interface ConversationPatch {
  type: 'conversationPatch';
  order: readonly string[];
  changed: readonly DisplayBlock[];
}

/**
 * A plan edit the user sent while a run was live: the Session's run-time edit
 * queue, applied at the next batch boundary unless withdrawn. Not a queued
 * prompt — those wait on a planner turn, not on a run (`heldPrompts`).
 */
export interface PendingPlanEdit {
  id: string;
  text: string;
}

export type WebviewToHost =
  | {
      type: 'sendMessage';
      text: string;
      runners?: RunnerId[];
      actionContext?: {
        type: 'approve' | 'reject' | 'retry' | 'skip' | 'cancel' | 'execute' | 'merge' | 'split' | 'addTask';
        taskId?: string;
      };
      /** The user typed it, so the conversation shows it as theirs; a button's message is not echoed. */
      typed?: boolean;
    }
  | { type: 'sendSystemCommand'; command: SystemCommand; taskId?: string }
  /**
   * The user answered an in-chat approval card. The id is the request's, so the
   * host resolves the same prompt any other surface would.
   */
  | { type: 'resolveApproval'; id: string; granted: boolean }
  /** Withdraw one pending plan edit before its batch boundary, so its words return to the input. */
  | { type: 'removePendingPlanEdit'; id: string }
  /**
   * A prompt typed while the planner answers. The host holds it and sends it
   * when the turn ends — or at once, if the turn ended before this arrived.
   */
  | { type: 'holdPrompt'; text: string }
  /** Take back the newest queued prompt; the host answers with `promptUnsent`. */
  | { type: 'unsendPrompt' }
  | { type: 'ready' }
  /** A per-task model dropdown opened — re-discover so a stale/degraded catalog self-heals. */
  | { type: 'refreshModels' }
  | { type: 'stopResearch' }
  | { type: 'newSession' }
  /** A notice the webview raised (a task action, the watchdog) — the conversation belongs to the host. */
  | { type: 'addNote'; text: string }
  | { type: 'toggleSkill'; skillId: string; enabled: boolean }
  /** Who plans (ADR-0009) — a vendor provider id or one of the harness planners. */
  | { type: 'setPlanner'; provider: string }
  /** The planner's own model and thinking effort, a pair so neither can outlive the other. */
  | { type: 'setPlannerModel'; modelId: string; effort?: string }
  /**
   * An action on an isolated run, from a task's conflict indicator or the
   * handoff card. Reviewing, merging, discarding and cleaning up are all
   * asymmetric operations the host alone can confirm and perform.
   */
  | { type: 'isolationAction'; action: IsolationActionKind; taskId?: string };

export type HostToWebview =
  | { type: 'setState'; state: ChatState }
  | ConversationPatch
  /** A planner turn opened or closed: what turns a send into a hold, and Esc into unsend or stop. */
  | { type: 'plannerTurn'; active: boolean }
  /** The planner is working without producing anything visible; keeps the webview's watchdog quiet. */
  | { type: 'plannerLiveness' }
  | { type: 'planUpdated'; plan: LegacyPlanState }
  | { type: 'executionStatus'; taskId: string; status: TaskStatus }
  | { type: 'taskOutput'; taskId: string; text: string }
  | { type: 'taskIdle'; taskId: string; idleSince: string | null }
  /** Every plan edit still waiting at a batch boundary, in the order it was sent. */
  | { type: 'pendingPlanEdits'; edits: PendingPlanEdit[] }
  /** The queued prompts the host is holding for the next planner turn, oldest first. */
  | { type: 'heldPrompts'; prompts: PromptHold }
  /** Queued text the host gave back, to go above whatever is in the input. */
  | { type: 'promptUnsent'; text: string }
  | { type: 'showError'; error: string }
  | { type: 'focusTask'; taskId: string }
  | { type: 'setModels'; models: DiscoveredModel[] }
  | { type: 'setRunners'; runners: RunnerMeta[] }
  // `unavailable` lists toggles that have no meaning for the current planner
  // backend — hidden rather than silently ignored (ADR-0009, T8).
  | { type: 'setSkillToggles'; toggles: { tdd: boolean; verify: boolean }; unavailable?: string[] }
  /** Discovered skills (global ~/.ordewell/skills/ + workspace .ordewell/skills/, workspace shadows global) for the /skill-name suggestion dropdown. */
  | { type: 'setSkills'; skills: { name: string; description: string }[] }
  | { type: 'setConfiguredProviders'; providers: AiProvider[] }
  | { type: 'setModelOptions'; modelOptions: ModelOption[] }
  | { type: 'setModelsByRunner'; modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> }
  | { type: 'setModesByRunner'; modesByRunner: Record<string, RunnerModeMeta[]> }
  | { type: 'setModelConfig'; modelConfig: { orchestrator: string; orchestratorProvider?: string } }
  | { type: 'setPlannerBackends'; backends: PlannerBackend[]; provider: string; runner?: string; effort?: string }
  | { type: 'setModelApiMapping'; modelApiMapping: Record<string, AiProvider[]> }
  | { type: 'setModelDiscoveryErrors'; errors: Record<string, string> }
  | { type: 'planApproved' }
  | { type: 'showWarnings'; warnings: string; pendingTasks: Task[] }
  | { type: 'checkpoint'; taskId: string; taskTitle: string; summary: string }
  | { type: 'setGoal'; goal: string }
  // Per-task isolation state (ADR-0013) — sent only for tasks that have one, so
  // a shared-root plan's cards stay quiet (US34).
  | { type: 'taskIsolation'; taskId: string; isolation: TaskIsolation }
  // The end-of-run handoff: each repo's integration branch and base, and what
  // landed, with the actions the host performs on request.
  | { type: 'isolationHandoff'; repos: IsolationHandoff['repos']; landed: IsolationHandoff['landed'] }
  // What "Merge all" did: all-or-nothing per repo, or which repos one landed in
  // before it stopped. A group of one reports its single merge as before.
  | { type: 'isolationMergeResult'; result: IsolationMergeResult }
  // The run's isolation is gone (discarded or the plan restarted); the handoff
  // card and every conflict indicator clear.
  | { type: 'isolationCleared' }
  /**
   * A session was (re)loaded: the webview drops the previous session's plan,
   * task output, isolation and any stuck busy state. The conversation itself
   * arrives as a `conversationPatch`.
   */
  | { type: 'restoreChat' }
  | { type: 'conversationBusy'; busy: boolean };
