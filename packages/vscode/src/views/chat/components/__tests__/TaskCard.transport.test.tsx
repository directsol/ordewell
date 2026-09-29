import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'in_progress',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'build',
    ...overrides,
  };
}

describe('TaskCard — runner transport (ADR-0018)', () => {
  it('names the structured transport on the collapsed card', () => {
    render(<TaskCard task={makeTask({ transport: { kind: 'structured' } })} models={[]} isExecuting />);
    expect(screen.getByText('Structured')).toBeTruthy();
  });

  it('says why a task that asked for structured ran in a terminal', () => {
    render(<TaskCard task={makeTask({ assignedRunner: 'codex', transport: { kind: 'terminal', fallback: 'no structured connector for Codex yet' } })} models={[]} isExecuting />);
    expect(screen.getByText('Terminal: no structured connector for Codex yet')).toBeTruthy();
    expect(screen.queryByText('Structured')).toBeNull();
  });

  it('shows nothing on a terminal plan', () => {
    render(<TaskCard task={makeTask()} models={[]} isExecuting />);
    expect(document.querySelector('.task-transport-badge')).toBeNull();
  });

  it('offers "Open log" only on a structured task', () => {
    render(<TaskCard task={makeTask({ transport: { kind: 'structured' } })} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(screen.getByText('Open log')).toBeTruthy();

    cleanup();
    render(<TaskCard task={makeTask()} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(screen.queryByText('Open log')).toBeNull();
  });

  it('asks the host to open the task log, without toggling the card', () => {
    const onOpenLog = vi.fn();
    render(<TaskCard task={makeTask({ transport: { kind: 'structured' } })} models={[]} isExecuting onOpenLog={onOpenLog} />);

    fireEvent.click(screen.getByText('Open log'));

    expect(onOpenLog).toHaveBeenCalledWith('t1');
  });
});
