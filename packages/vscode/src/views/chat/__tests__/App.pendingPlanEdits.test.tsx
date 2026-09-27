import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import App from '../App';
import { api, post } from './hostBridge';

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;

describe('pending plan edits', () => {
  beforeEach(() => {
    render(<App />);
    api.postMessage.mockClear();
  });

  it('shows each waiting edit as pending, not as a sent message', () => {
    post({ type: 'pendingPlanEdits', edits: [{ id: 'q-1', text: 'also add tests' }, { id: 'q-2', text: 'rename the CLI' }] });

    const items = [...document.querySelectorAll('.pending-plan-edit')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('also add tests');
    expect(items[0].textContent?.toLowerCase()).toContain('pending edit');
    expect(items[1].textContent).toContain('rename the CLI');
    // Sent messages are transcript bubbles; a waiting one is not.
    expect(document.querySelector('.chat-msg-user')).toBeNull();
  });

  it('withdraws one with ×, putting its words back in the input', () => {
    post({ type: 'pendingPlanEdits', edits: [{ id: 'q-1', text: 'also add tests' }] });

    fireEvent.click(document.querySelector('.pending-plan-edit-remove')!);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removePendingPlanEdit', id: 'q-1' });
    expect(textarea().value).toBe('also add tests');
    expect(document.querySelector('.pending-plan-edit')).toBeNull();
  });

  it('leaves the others in place, and lets the host\'s own view win after a withdrawal', () => {
    post({ type: 'pendingPlanEdits', edits: [{ id: 'q-1', text: 'one' }, { id: 'q-2', text: 'two' }] });
    fireEvent.click(document.querySelector('.pending-plan-edit-remove')!);

    // What the host posts back after removing q-1.
    post({ type: 'pendingPlanEdits', edits: [{ id: 'q-2', text: 'two' }] });

    const items = [...document.querySelectorAll('.pending-plan-edit')];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('two');
  });

  it('clears the list when the host says the batch applied it', () => {
    post({ type: 'pendingPlanEdits', edits: [{ id: 'q-1', text: 'one' }] });
    post({ type: 'pendingPlanEdits', edits: [] });

    expect(document.querySelector('.pending-plan-edit')).toBeNull();
  });
});
