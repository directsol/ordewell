import * as vscode from 'vscode';
import type { SessionMessage, Task } from '@ordewell/core';
import { TaskLogPanel, taskTabTitle, type TaskLogSession } from './TaskLogPanel';

/** The editor tab's view type; one panel per task is keyed by task id, not by this. */
export const TASK_LOG_VIEW_TYPE = 'ordewellTaskLog';

export interface TaskLogRegistryDeps {
  extensionUri: vscode.Uri;
  session: () => TaskLogSession;
  getTask: (taskId: string) => Task | undefined;
  log: (msg: string) => void;
}

/**
 * The open task-log tabs, keyed by task (ADR-0018, V1). Nothing here opens a
 * panel by itself: `open` is what the chat's "Open log" reaches, and reusing an
 * already-open tab focuses it rather than opening a second. Every session
 * event is offered to each open panel, which filters to its own task.
 */
export class TaskLogRegistry {
  private readonly panels = new Map<string, TaskLogPanel>();

  constructor(private readonly deps: TaskLogRegistryDeps) {}

  open(taskId: string): void {
    const existing = this.panels.get(taskId);
    if (existing) {
      existing.reveal();
      return;
    }
    const task = this.deps.getTask(taskId);
    if (!task) {
      this.deps.log(`No task ${taskId} to open a task log for.`);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TASK_LOG_VIEW_TYPE,
      taskTabTitle(task),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const controller = new TaskLogPanel(
      panel,
      taskId,
      { session: this.deps.session(), getTask: this.deps.getTask, log: this.deps.log },
      this.deps.extensionUri,
      () => { this.panels.delete(taskId); },
    );
    this.panels.set(taskId, controller);
  }

  receive(msg: SessionMessage): void {
    for (const panel of this.panels.values()) panel.receive(msg);
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }
}
