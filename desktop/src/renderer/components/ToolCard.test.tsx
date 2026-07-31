// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChatProvider } from '../state/chat-context';
import ToolCard from './ToolCard';
import type { ToolCallState } from '../../shared/types';

function makeTool(overrides: Partial<ToolCallState>): ToolCallState {
  return {
    toolUseId: 'toolu_test',
    toolName: 'Bash',
    input: {},
    status: 'complete',
    ...overrides,
  };
}

describe('ToolCard — Skill compact variant', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders Skill without an expand chevron', () => {
    const tool = makeTool({
      toolName: 'Skill',
      input: { skill: 'superpowers:brainstorming' },
      response: 'Launching skill: superpowers:brainstorming',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} />
      </ChatProvider>
    );
    expect(screen.queryByTestId('tool-card-chevron')).toBeNull();
  });

  it('renders Skill without a tool body', () => {
    const tool = makeTool({
      toolName: 'Skill',
      input: { skill: 'superpowers:brainstorming' },
      response: 'Launching skill: superpowers:brainstorming',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} />
      </ChatProvider>
    );
    expect(screen.queryByTestId('tool-card-body')).toBeNull();
    // Header label uses the new "Invoked skill: <bare-name>" format (namespace stripped).
    expect(screen.getByText(/Invoked skill: brainstorming/)).toBeInTheDocument();
  });

  it('renders non-Skill tool with the chevron present', () => {
    const tool = makeTool({ toolName: 'Bash', input: { command: 'ls' } });
    render(
      <ChatProvider>
        <ToolCard tool={tool} />
      </ChatProvider>
    );
    expect(screen.queryByTestId('tool-card-chevron')).not.toBeNull();
  });
});

describe('ToolCard — expired approval card', () => {
  const originalClaude = (window as any).claude;

  beforeEach(() => {
    cleanup();
    (window as any).claude = { remote: { broadcastAction: () => {} } };
  });

  afterEach(() => {
    (window as any).claude = originalClaude;
  });

  it('renders a normal (non-expired) awaiting-approval card with Yes/No, not header-only', () => {
    const tool = makeTool({
      toolName: 'Bash',
      input: { command: 'ls' },
      status: 'awaiting-approval',
      requestId: 'req-1',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} sessionId="s1" />
      </ChatProvider>
    );
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  // The bug this task fixes: retention (Task 3) clears requestId on a
  // retained card, but the old gate (`tool.requestId &&`) required it — so a
  // retained card rendered header-only, with no explanation and no way out,
  // on a session whose red attention dot stayed lit.
  it('widens the gate so an expired card (requestId cleared) still renders UI', () => {
    const tool = makeTool({
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/x' },
      status: 'awaiting-approval',
      requestId: undefined,
      expired: true,
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} sessionId="s1" />
      </ChatProvider>
    );
    expect(
      screen.getByText(/The buttons on this card timed out, but Claude may still be/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss — I answered in the terminal/ })).toBeInTheDocument();
    // The old Yes/No/Always Allow row must NOT render — requestId is gone,
    // so those buttons could never deliver a response anyway.
    expect(screen.queryByText('Yes')).toBeNull();
    expect(screen.queryByText('No')).toBeNull();
  });

  it('Dismiss on an expired card dispatches PERMISSION_CARD_RESOLVED and mirrors to remote', () => {
    const broadcastAction = vi.fn();
    (window as any).claude = { remote: { broadcastAction } };
    const tool = makeTool({
      toolName: 'Bash',
      input: { command: 'ls' },
      status: 'awaiting-approval',
      requestId: undefined,
      expired: true,
      toolUseId: 'toolu_expired_1',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} sessionId="s1" />
      </ChatProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Dismiss — I answered in the terminal/ }));
    expect(broadcastAction).toHaveBeenCalledWith({
      type: 'PERMISSION_CARD_RESOLVED',
      sessionId: 's1',
      toolUseId: 'toolu_expired_1',
    });
  });

  it('AskUserQuestion also gets the expired branch with Dismiss as its only out', () => {
    const tool = makeTool({
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Pick one', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        ],
      },
      status: 'awaiting-approval',
      requestId: undefined,
      expired: true,
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} sessionId="s1" />
      </ChatProvider>
    );
    expect(screen.getByRole('button', { name: /Dismiss — I answered in the terminal/ })).toBeInTheDocument();
    // The question options themselves must not render — there's no live
    // socket to submit answers through.
    expect(screen.queryByText('Pick one')).toBeNull();
  });

  // A delivered===false response means the socket is provably gone — under
  // the new retention rules (Task 3), a bare PERMISSION_EXPIRED with no
  // reason would still resolve (reason absent defaults to resolve), but this
  // pins the intent explicitly so a future reducer default change can't
  // silently start retaining these.
  it('tags delivery failure (delivered === false) with reason: delivery-failed', () => {
    const broadcastAction = vi.fn();
    (window as any).claude = {
      remote: { broadcastAction },
      session: { respondToPermission: vi.fn().mockResolvedValue(false) },
    };
    const tool = makeTool({
      toolName: 'Bash',
      input: { command: 'ls' },
      status: 'awaiting-approval',
      requestId: 'req-1',
      toolUseId: 'toolu_del_fail',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} sessionId="s1" />
      </ChatProvider>
    );
    fireEvent.click(screen.getByText('Yes'));
    return Promise.resolve().then(() => {
      expect(broadcastAction).toHaveBeenCalledWith({
        type: 'PERMISSION_EXPIRED',
        sessionId: 's1',
        requestId: 'req-1',
        reason: 'delivery-failed',
      });
    });
  });
});
