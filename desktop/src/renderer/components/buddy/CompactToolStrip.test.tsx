// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChatProvider } from '../../state/chat-context';
import { CompactToolStrip } from './CompactToolStrip';
import type { ToolCallState } from '../../../shared/types';

function makeTool(overrides: Partial<ToolCallState>): ToolCallState {
  return {
    toolUseId: 'toolu_test',
    toolName: 'Bash',
    input: { command: 'ls' },
    status: 'complete',
    ...overrides,
  };
}

describe('CompactToolStrip — expired approval card', () => {
  const originalClaude = (window as any).claude;

  beforeEach(() => {
    cleanup();
    (window as any).claude = { remote: { broadcastAction: () => {} } };
  });

  afterEach(() => {
    (window as any).claude = originalClaude;
  });

  it('renders Allow/Deny/Always for a normal (non-expired) awaiting-approval tool', () => {
    const tool = makeTool({ status: 'awaiting-approval', requestId: 'req-1' });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>
    );
    expect(screen.getByText('✓ Allow')).toBeInTheDocument();
    expect(screen.getByText('✕ Deny')).toBeInTheDocument();
    expect(screen.getByText('∞ Always')).toBeInTheDocument();
  });

  // Same bug as ToolCard: the old gate (`tool.requestId &&`) required a live
  // requestId, but a retained card clears it — so a retained card in the
  // buddy strip showed an amber dot with no Allow/Deny/Always row AND no
  // Dismiss, leaving the user with no in-app way to act on it.
  it('widens the gate so an expired card (requestId cleared) shows a Dismiss button instead of nothing', () => {
    const tool = makeTool({ status: 'awaiting-approval', requestId: undefined, expired: true });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>
    );
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
    expect(screen.queryByText('✓ Allow')).toBeNull();
    expect(screen.queryByText('✕ Deny')).toBeNull();
    expect(screen.queryByText('∞ Always')).toBeNull();
  });

  it('Dismiss on an expired card dispatches PERMISSION_CARD_RESOLVED and mirrors to remote', () => {
    const broadcastAction = vi.fn();
    (window as any).claude = { remote: { broadcastAction } };
    const tool = makeTool({
      status: 'awaiting-approval',
      requestId: undefined,
      expired: true,
      toolUseId: 'toolu_expired_1',
    });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>
    );
    fireEvent.click(screen.getByText('Dismiss'));
    expect(broadcastAction).toHaveBeenCalledWith({
      type: 'PERMISSION_CARD_RESOLVED',
      sessionId: 's1',
      toolUseId: 'toolu_expired_1',
    });
  });

  // Same rationale as ToolCard's delivery-failed test: delivered===false
  // means the socket is provably gone, so this dispatch must RESOLVE (never
  // retain) — tag it explicitly rather than relying on the reducer's default.
  it('tags delivery failure (delivered === false) with reason: delivery-failed', async () => {
    const broadcastAction = vi.fn();
    (window as any).claude = {
      remote: { broadcastAction },
      session: { respondToPermission: vi.fn().mockResolvedValue(false) },
    };
    const tool = makeTool({ status: 'awaiting-approval', requestId: 'req-1' });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>
    );
    fireEvent.click(screen.getByText('✓ Allow'));
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastAction).toHaveBeenCalledWith({
      type: 'PERMISSION_EXPIRED',
      sessionId: 's1',
      requestId: 'req-1',
      reason: 'delivery-failed',
    });
  });

  it('tags a thrown respond() error with reason: delivery-failed', async () => {
    const broadcastAction = vi.fn();
    (window as any).claude = {
      remote: { broadcastAction },
      session: { respondToPermission: vi.fn().mockRejectedValue(new Error('socket closed')) },
    };
    const tool = makeTool({ status: 'awaiting-approval', requestId: 'req-1' });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>
    );
    fireEvent.click(screen.getByText('✓ Allow'));
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastAction).toHaveBeenCalledWith({
      type: 'PERMISSION_EXPIRED',
      sessionId: 's1',
      requestId: 'req-1',
      reason: 'delivery-failed',
    });
  });
});
