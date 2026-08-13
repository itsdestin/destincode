// @vitest-environment jsdom
/**
 * A preparing card is an ORDINARY running card — spinner, header, chevron — with
 * two text surfaces swapped. If it ever needs a bespoke visual state, the
 * "preparing is a flag, not a status" decision needs revisiting first.
 *
 * Drives the real ToolCard inside ChatProvider and expands by clicking, the same
 * way tool-body-malformed-input.test.tsx does — ToolBody calls useChatState and
 * cannot be rendered bare.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard, { friendlyToolDisplay } from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

// This suite mounts several cards; auto-cleanup isn't configured globally, so
// clean up explicitly or queries match prior tests' leftover DOM.
afterEach(cleanup);

const preparingWrite: ToolCallState = {
  toolUseId: 'c1',
  toolName: 'Write',
  input: {},
  status: 'running',
  preparing: true,
  preparingChars: 1240,
} as ToolCallState;

function renderExpanded(t: ToolCallState): HTMLElement {
  const { container } = render(<ChatProvider><ToolCard tool={t} sessionId="s1" /></ChatProvider>);
  fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
  expect(screen.getByTestId('tool-card-body')).toBeTruthy();
  return container;
}

describe('preparing tool card', () => {
  it('shows a thousands-separated character count in the collapsed detail line', () => {
    expect(friendlyToolDisplay(preparingWrite).detail).toBe('preparing… 1,240 chars');
  });

  it('keeps the tool name as the label so you can tell what is being composed', () => {
    expect(friendlyToolDisplay(preparingWrite).label).toContain('Write');
  });

  it('handles a card that has not counted anything yet', () => {
    const display = friendlyToolDisplay({ ...preparingWrite, preparingChars: 0 } as ToolCallState);
    expect(display.detail).toBe('preparing… 0 chars');
  });

  it('renders the preparing body instead of the argument view', () => {
    const container = renderExpanded(preparingWrite);
    expect(container.textContent).toContain('Still preparing tool call… 1,240 characters so far');
  });

  it('renders the normal argument view once preparing is gone', () => {
    // The real tool-use overwrites the entry wholesale, dropping the flag.
    const container = renderExpanded({
      toolUseId: 'c1', toolName: 'Write', status: 'running',
      input: { file_path: '/tmp/a.ts', content: 'hello' },
    } as ToolCallState);
    expect(container.textContent).not.toContain('Still preparing');
  });
});
