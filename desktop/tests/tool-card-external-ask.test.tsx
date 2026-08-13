// @vitest-environment jsdom
/**
 * Pins the "Always allow" suppression for an EXTERNAL-directory ask (ToolCard.tsx).
 *
 * A path outside the session's folder forces an ask and skips the permission
 * rules entirely on every future call (harness-session.ts, step 4), so a rule
 * remembered from this card could never fire. Offering the button would promise
 * the user something the engine will not honor — so the card offers Yes/No only.
 * See spec 2026-08-11 (permissions management UI), finding 3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

beforeEach(() => {
  (window as any).claude = { session: { respondToPermission: vi.fn().mockResolvedValue(true) }, remote: { broadcastAction: vi.fn() } };
});

// This suite mounts the same card repeatedly; auto-cleanup isn't configured
// globally, so unmount explicitly or queries match prior tests' leftover DOM.
afterEach(cleanup);

const askingTool = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'tool-1',
  toolName: 'Write',
  input: { file_path: '/somewhere/else/notes.md' },
  status: 'awaiting-approval',
  requestId: 'native-abc123',
  ...over,
} as ToolCallState);

const renderCard = (tool: ToolCallState) =>
  render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);

describe('external-directory ask', () => {
  it('suppresses Always allow for an external-directory ask', () => {
    renderCard(askingTool({ external: true }));
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull();
    // The ask itself is unaffected — the user can still answer it.
    expect(screen.getByRole('button', { name: /^yes$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^no$/i })).toBeTruthy();
  });

  // The control: a native ask inside the project keeps the button, so the test
  // above cannot pass by the button having been removed for everyone.
  it('still offers Always allow for an ordinary in-project native ask', () => {
    renderCard(askingTool());
    expect(screen.getByRole('button', { name: /always/i })).toBeTruthy();
  });
});
