import { describe, it, expect } from 'vitest';
import { removalPrompt, taskFromDraft } from '../taskEdit';
import type { TaskDraft } from '../../shared/protocol';
import { createTask, type Task } from '@ordewell/core';

function chain(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup' }),
    createTask({ id: 'b', order: 2, title: 'Build', dependencies: ['a'] }),
    createTask({ id: 'c', order: 3, title: 'Test', dependencies: ['a', 'b'] }),
  ];
}

describe('removalPrompt', () => {
  it('names the task', () => {
    expect(removalPrompt(chain(), 'c')).toBe('Remove "Test"?');
  });

  it('names the dependents that will silently lose the edge', () => {
    const prompt = removalPrompt(chain(), 'a');

    expect(prompt).toContain('Remove "Setup"?');
    expect(prompt).toContain('2 tasks depend on it');
    expect(prompt).toContain('#2 Build');
    expect(prompt).toContain('#3 Test');
  });

  it('agrees in number for a single dependent', () => {
    expect(removalPrompt(chain(), 'b')).toContain('1 task depends on it');
  });

  it('finds a subtask, whose dependents live in the same flattened graph', () => {
    const tasks = chain();
    tasks[0].subtasks = [createTask({ id: 'a1', order: 1, title: 'Nested' })];

    expect(removalPrompt(tasks, 'a1')).toBe('Remove "Nested"?');
  });

  it('stays answerable when the id is already gone', () => {
    expect(removalPrompt(chain(), 'ghost')).toBe('Remove this task?');
  });
});

describe('taskFromDraft', () => {
  it('reads a filled-in form', () => {
    const task = taskFromDraft({
      title: 'Write docs',
      prompt: 'do it',
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' },
      taskMode: 'agent',
      dependencies: ['a'],
    });

    expect(task).toEqual({
      title: 'Write docs',
      description: 'Write docs',
      prompt: 'do it',
      type: 'ai',
      dependencies: ['a'],
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' },
      taskMode: 'agent',
    });
  });

  it('leaves the assignment unset so the session derives it', () => {
    const task = taskFromDraft({ title: 'Write docs', dependencies: [] });

    expect(task).toMatchObject({ prompt: 'Write docs', dependencies: [] });
    expect(task!.assignedRunner).toBeUndefined();
    expect(task!.assignedModel).toBeUndefined();
    expect(task!.taskMode).toBeUndefined();
  });

  it('refuses a draft with no usable title, rather than adding a nameless task', () => {
    expect(taskFromDraft({ title: '   ', dependencies: [] })).toBeNull();
  });

  it('never lets a caller inject system-owned fields', () => {
    const smuggled = { title: 'X', dependencies: [], id: 'hijack', status: 'completed', verdict: {} } as unknown as TaskDraft;
    const task = taskFromDraft(smuggled);

    expect(task).not.toHaveProperty('id');
    expect(task).not.toHaveProperty('status');
    expect(task).not.toHaveProperty('verdict');
  });
});
