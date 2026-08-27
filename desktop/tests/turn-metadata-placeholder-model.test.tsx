// @vitest-environment jsdom
// desktop/tests/turn-metadata-placeholder-model.test.tsx
//
// Fix (2026-08-26): the per-turn metadata strip printed `turn.model` raw, so
// Claude Code's `<synthetic>` placeholder — stamped on notices CC composed
// itself (session limit, out of credits, /login) — rendered to the user as if
// it were a model name. Own file because it has to force the theme pref
// `showTurnMetadata` on, and vi.mock is file-scoped: flipping it inside
// AssistantTurnBubble.test.tsx would add the strip's text to every other
// container.textContent assertion there.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../src/renderer/state/theme-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/state/theme-context')>();
  return { ...actual, useTheme: () => ({ ...actual.useTheme(), showTurnMetadata: true }) };
});

import { ChatProvider } from '../src/renderer/state/chat-context';
import AssistantTurnBubble from '../src/renderer/components/AssistantTurnBubble';
import type { AssistantTurn } from '../src/renderer/state/chat-types';

function turnWithModel(model: string | null): AssistantTurn {
  return {
    id: 'turn_meta',
    segments: [{ type: 'text', content: 'hello', messageId: 'm1' }],
    timestamp: 0,
    stopReason: 'end_turn',
    model,
    usage: null,
    anthropicRequestId: null,
  };
}

function renderTurn(model: string | null) {
  return render(
    <ChatProvider>
      <AssistantTurnBubble
        turn={turnWithModel(model)}
        toolGroups={new Map()}
        toolCalls={new Map()}
        sessionId="test"
        showTimestamps={false}
      />
    </ChatProvider>
  );
}

describe('turn metadata strip — model line', () => {
  beforeEach(() => cleanup());

  it('prints a real model id', () => {
    // Without this the test below passes on a strip that renders nothing at all.
    expect(renderTurn('claude-opus-5').container.textContent).toContain('claude-opus-5');
  });

  it('never prints CC\'s <synthetic> placeholder', () => {
    // Nothing replaces it — the turn genuinely ran on no model, so the line is
    // simply absent rather than substituted with a guess.
    expect(renderTurn('<synthetic>').container.textContent).not.toContain('synthetic');
  });
});
