// @vitest-environment jsdom
// Pins spec §2.1 (card LAST in the bubble, calls hoisted out of the tool
// group, prose padding for a card-only bubble, multi-call merge) and §5
// (friendlyToolDisplay + ToolBody fallbacks never show raw JSON).
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { AssistantTurn } from '../src/renderer/state/chat-types';
import type { ToolCallState, ToolGroupState } from '../src/shared/types';

vi.mock('../src/renderer/components/ArtifactThumbnail', () => ({
  ArtifactThumbnail: () => <div data-testid="thumb" />,
}));
vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import AssistantTurnBubble from '../src/renderer/components/AssistantTurnBubble';
import ToolCard, { friendlyToolDisplay } from '../src/renderer/components/ToolCard';

(window as any).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} });
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

afterEach(cleanup);

const send = (id: string, files: string[]): ToolCallState =>
  ({ toolUseId: id, toolName: 'SendUserFile', input: { files, status: 'normal' }, status: 'complete', response: `Sent ${files.length} file(s) to the user.` });
const bash = (id: string): ToolCallState =>
  ({ toolUseId: id, toolName: 'Bash', input: { command: 'node scripts/perf.mjs' }, status: 'complete', response: 'ok' });

function turn(segments: AssistantTurn['segments']): AssistantTurn {
  return { id: 'turn_1', segments, timestamp: 0, stopReason: null, model: null, usage: null, anthropicRequestId: null };
}

function renderTurn(t: AssistantTurn, groups: Record<string, string[]>, calls: ToolCallState[]) {
  const toolGroups = new Map<string, ToolGroupState>(Object.entries(groups).map(([id, toolIds]) => [id, { id, toolIds }]));
  const toolCalls = new Map(calls.map((c) => [c.toolUseId, c]));
  return render(
    <ChatProvider>
      <AssistantTurnBubble turn={t} toolGroups={toolGroups} toolCalls={toolCalls} sessionId="s" showTimestamps={false} />
    </ChatProvider>,
  );
}

describe('Deliverables card in the bubble', () => {
  it('renders LAST in the bubble and its call is absent from the tool group', () => {
    renderTurn(
      turn([{ type: 'text', content: 'Done.', messageId: 'm1' }, { type: 'tool-group', groupId: 'g1' }]),
      { g1: ['send1', 'bash1'] },   // SendUserFile listed FIRST; must render LAST, outside the group
      [send('send1', ['/p/report.md']), bash('bash1')],
    );
    const card = screen.getByTestId('deliverables-card');
    expect(card.nextElementSibling).toBeNull();                 // nothing after it in the bubble
    expect(screen.queryByText(/Sent a file/)).toBeNull();        // no ToolCard was drawn for the call
    expect(screen.getByText(/perf\.mjs/)).toBeInTheDocument();  // the Bash card still renders
    expect(card.compareDocumentPosition(screen.getByText(/perf\.mjs/)) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('a bubble holding only the card gets prose padding, not the tools-only padding', () => {
    const { container } = renderTurn(
      turn([{ type: 'tool-group', groupId: 'g1' }]),
      { g1: ['send1'] },
      [send('send1', ['/p/report.md'])],
    );
    const bubble = container.querySelector('.assistant-bubble') as HTMLElement;
    expect(bubble.className).toContain('pt-4');
    expect(bubble.className).not.toContain('py-2.5');
  });

  it('merges every SendUserFile call in the bubble into ONE card', () => {
    renderTurn(
      turn([{ type: 'text', content: 'Two batches.', messageId: 'm1' }, { type: 'tool-group', groupId: 'g1' }, { type: 'tool-group', groupId: 'g2' }]),
      { g1: ['send1'], g2: ['send2', 'bash1'] },
      [send('send1', ['/p/a.md']), send('send2', ['/p/b.md', '/p/c.md']), bash('bash1')],
    );
    expect(screen.getAllByTestId('deliverables-card')).toHaveLength(1);
    fireEvent.click(screen.getByText('Deliverables')); // card mounts closed now — open it to see the tiles
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(3);
  });
});

describe('fallback surfaces', () => {
  it('friendlyToolDisplay: singular, plural, and never "Sent 0 files" on malformed input', () => {
    expect(friendlyToolDisplay({ toolName: 'SendUserFile', input: { files: ['/p/a.md'] } } as any))
      .toEqual({ label: 'Sent a file', detail: '↳ a.md' });
    expect(friendlyToolDisplay({ toolName: 'SendUserFile', input: { files: ['/p/a.md', '/q/b.png'] } } as any))
      .toEqual({ label: 'Sent 2 files', detail: '↳ a.md, b.png' });
    // Pin the label only: whether the code yields '' or '↳ ' for detail on
    // garbage input is not worth a rule.
    expect(friendlyToolDisplay({ toolName: 'SendUserFile', input: { files: 'not-an-array' } } as any).label)
      .toBe('Sent files');
  });

  it('a bare SendUserFile ToolCard expands to the card, not the raw JSON view', () => {
    render(
      <ChatProvider>
        <ToolCard tool={send('send1', ['/p/report.md'])} sessionId="s" />
      </ChatProvider>,
    );
    fireEvent.click(screen.getByTestId('tool-card-chevron'));
    expect(screen.getByTestId('deliverables-card')).toBeInTheDocument();
    expect(screen.queryByText(/"files"/)).toBeNull();
  });
});
