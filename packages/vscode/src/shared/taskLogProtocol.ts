import type { AwaitingReason, DisplayBlock, StructuredTurnEnd, TaskStatus } from '@ordewell/core';

/*
 * The messages between the extension host and a task-log panel (ADR-0018, V1).
 * Types only: the host (tsup) and the panel (Vite) each compile this file, so
 * neither can drift from what the other sends. The panel is its own webview —
 * one editor tab per task — so it has its own protocol rather than borrowing
 * the chat's, which is shaped around the planner conversation.
 */

/** One message waiting behind a structured task's running turn. */
export interface TaskLogQueuedMessage {
  id: string;
  text: string;
}

/**
 * Everything the panel draws besides the log blocks: the header's identity and
 * live state, the attempt switcher, and the composer's queue. Derived on the
 * host from the reduced view and the task, so the panel never has to know the
 * plan.
 */
export interface TaskLogStatus {
  taskId: string;
  order: number;
  title: string;
  runner: string;
  planStatus: TaskStatus;
  awaitingReason?: AwaitingReason;
  /** A turn is live. */
  working: boolean;
  /** How the last turn ended; absent before the first one does. */
  lastTurnEnd?: StructuredTurnEnd;
  /** Messages waiting for the running turn to end, oldest first. */
  queued: readonly TaskLogQueuedMessage[];
  /** Attempts that have a saved log, oldest first. */
  attempts: readonly number[];
  /** Which attempt the blocks below belong to. */
  attempt: number;
}

export type HostToTaskLog =
  /** The panel opened, or switched attempt: the whole view it should draw. */
  | { type: 'init'; status: TaskLogStatus; blocks: readonly DisplayBlock[] }
  /** Blocks new or changed since the last patch, with the new order. */
  | { type: 'patch'; order: readonly string[]; changed: readonly DisplayBlock[] }
  /** The header or queue changed; the blocks did not. */
  | { type: 'status'; status: TaskLogStatus }
  | { type: 'showError'; error: string };

export type TaskLogToHost =
  | { type: 'ready' }
  | { type: 'sendTaskMessage'; text: string }
  | { type: 'removeQueuedTaskMessage'; id: string }
  | { type: 'interruptTask' }
  /** Show an earlier attempt; the host answers with `init`. */
  | { type: 'selectAttempt'; attempt: number };
