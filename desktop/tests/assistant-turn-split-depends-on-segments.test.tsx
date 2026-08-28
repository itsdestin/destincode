// @vitest-environment jsdom
// Perf cycle 1, N3 (docs/active/handoffs/2026-08-27-perf-cycle-1-handoff.md §3).
//
// AssistantTurnBubble memoises splitIntoBubbles on `turn.segments`, NOT on
// `turn`: the reducer mints a new turn object for every change to a turn (a
// streamed delta, a model capture, the usage/stopReason stamp at turn-complete,
// a tool routed through it), so keying on `turn` never hit while a turn was
// live. The memo key is only sound while splitIntoBubbles reads nothing but
// the segments. This pins that premise from both sides: the same segments
// under different metadata split identically, and the split is a pure
// function of the segments array (deep-equal in, deep-equal out).
import { describe, it, expect, vi } from 'vitest';

// splitIntoBubbles lives in the component module, which pulls the markdown
// pipeline in at import time; it is irrelevant here.
vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { splitIntoBubbles } from '../src/renderer/components/AssistantTurnBubble';
import type { AssistantTurn, AssistantTurnSegment } from '../src/renderer/state/chat-types';

const segments: AssistantTurnSegment[] = [
  { type: 'reasoning', content: 'thinking…', messageId: 'r1', partId: 'p0' },
  { type: 'text', content: 'Hello, world', messageId: 'm1', partId: 'p1' },
  { type: 'tool-group', groupId: 'g1' },
  { type: 'text', content: 'Done.', messageId: 'm2', partId: 'p2' },
];

const liveTurn: AssistantTurn = {
  id: 'turn_1',
  segments,
  timestamp: 1000,
  stopReason: null,
  model: null,
  usage: null,
  anthropicRequestId: null,
};

describe('splitIntoBubbles depends on the segments alone', () => {
  it('the same segments split identically under every other field the reducer stamps later', () => {
    const completed: AssistantTurn = {
      ...liveTurn,
      timestamp: 2000,
      stopReason: 'max_tokens',
      model: 'claude-opus-5',
      usage: { inputTokens: 12, outputTokens: 34 } as any,
      anthropicRequestId: 'req_abc',
    };
    expect(splitIntoBubbles(completed)).toEqual(splitIntoBubbles(liveTurn));
  });

  it('is a pure function of the segments array (a deep-equal copy splits deep-equal)', () => {
    const copy = { segments: segments.map((s) => ({ ...s })) };
    expect(splitIntoBubbles(copy)).toEqual(splitIntoBubbles(liveTurn));
    // Sanity: it really does read the segments — a changed delta changes the split.
    const grown = { segments: [...segments.slice(0, 3), { ...segments[3], content: 'Done. And more.' }] };
    expect(splitIntoBubbles(grown)).not.toEqual(splitIntoBubbles(liveTurn));
  });
});
