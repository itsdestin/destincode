// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import UserMessage from './UserMessage';
import type { ChatMessage } from '../../shared/types';

// Task 11 (cancel/edit queued messages): Cancel ✕ / Edit ✎ affordances on a
// queued bubble. UserMessage itself does no IPC/dispatch — it's a pure
// callback-prop component (see the WHY comment on its Props) — so these tests
// only cover render-gating and that clicks call through with the right args,
// mirroring how ChatView actually wires them (sessionId + queueId + text).

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm-1', role: 'user', content: 'hello world', timestamp: 1, ...overrides };
}

afterEach(() => {
  cleanup();
});

describe('UserMessage — queued Cancel/Edit affordances (Task 11)', () => {
  it('renders neither affordance when not queued', () => {
    render(
      <UserMessage
        message={makeMessage()}
        sessionId="s-1"
        showTimestamps={false}
        pending
        queued={false}
        onCancelQueued={vi.fn()}
        onEditQueued={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
  });

  it('renders neither affordance once confirmed (queued but not pending)', () => {
    render(
      <UserMessage
        message={makeMessage()}
        sessionId="s-1"
        showTimestamps={false}
        pending={false}
        queued
        queueId="q-1"
        onCancelQueued={vi.fn()}
        onEditQueued={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
  });

  it('renders neither affordance when queued+pending but no queueId (defensive: should never happen)', () => {
    render(
      <UserMessage
        message={makeMessage()}
        sessionId="s-1"
        showTimestamps={false}
        pending
        queued
        onCancelQueued={vi.fn()}
        onEditQueued={vi.fn()}
      />,
    );
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
  });

  it('renders neither affordance when queued+pending+queueId but no handlers wired', () => {
    render(
      <UserMessage
        message={makeMessage()}
        sessionId="s-1"
        showTimestamps={false}
        pending
        queued
        queueId="q-1"
      />,
    );
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
  });

  it('renders both affordances on a queued+pending bubble with a queueId, and wires clicks with (queueId[, text])', () => {
    const onCancelQueued = vi.fn();
    const onEditQueued = vi.fn();
    render(
      <UserMessage
        message={makeMessage({ content: 'edit me please' })}
        sessionId="s-1"
        showTimestamps={false}
        pending
        queued
        queueId="q-42"
        onCancelQueued={onCancelQueued}
        onEditQueued={onEditQueued}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    expect(onCancelQueued).toHaveBeenCalledWith('q-42');

    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    expect(onEditQueued).toHaveBeenCalledWith('q-42', 'edit me please');
  });

  it('renders only Cancel when onEditQueued is not provided', () => {
    render(
      <UserMessage
        message={makeMessage()}
        sessionId="s-1"
        showTimestamps={false}
        pending
        queued
        queueId="q-1"
        onCancelQueued={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
  });
});
