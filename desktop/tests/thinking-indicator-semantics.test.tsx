// @vitest-environment jsdom
// The thinking indicator answers exactly one question: "is it alive?" — and it
// should appear ONLY when the user has no other evidence of progress.
//
// Destin, 2026-07-26: "during live token output/generation, there really
// shouldn't be any spinner or thinking indicator at all (for either local or
// cloud models). The thinking indicator/spinner only exists to show that the
// model isn't stalled when no output is actively being produced."
//
// ChatView already suppresses it for running tools and pending approvals; the
// streaming case had no signal at all until `lastOutputAt` was added, so a
// spinner sat under a bubble that was actively filling.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import ThinkingIndicator from '../src/renderer/components/ThinkingIndicator';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ThinkingIndicator — when it may appear at all', () => {
  it('renders NOTHING while output is actively arriving', () => {
    const { container } = render(<ThinkingIndicator lastOutputAt={Date.now()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders once output has paused past the grace window', () => {
    const { container } = render(<ThinkingIndicator lastOutputAt={Date.now() - 10_000} />);
    expect(container.innerHTML).not.toBe('');
  });

  it('renders when no output has ever arrived — the first-token wait', () => {
    // This is the case the indicator exists for: nothing on screen yet.
    const { container } = render(<ThinkingIndicator lastOutputAt={null} />);
    expect(container.innerHTML).not.toBe('');
  });

  it('a stall warning OUTRANKS streaming — if something may be wrong, say so', () => {
    // Suppressing a genuine "this may be broken" warning because a token landed
    // a moment ago would hide the one message the user most needs.
    render(
      <ThinkingIndicator
        lastOutputAt={Date.now()}
        stallWarning={{ retryInMs: 15_000, willRetry: true }}
      />,
    );
    expect(screen.getByText(/taking a while/i)).toBeTruthy();
  });
});

describe('ThinkingIndicator — what it says while waiting', () => {
  it('names the PROMPT on the first step', () => {
    render(<ThinkingIndicator promptProcessing={{ promptTokens: 25_000, budgetMs: 600_000, source: 'prompt' }} />);
    expect(screen.getByText(/Reading your prompt — 25,000 tokens/)).toBeTruthy();
  });

  it('names TOOL OUTPUT after a tool call — "your prompt" is wrong there', () => {
    // The exact confusion Destin flagged: this text appeared after a Read, where
    // the new context is the file, not anything the user typed.
    render(<ThinkingIndicator promptProcessing={{ promptTokens: 98_000, budgetMs: 600_000, source: 'tool-output' }} />);
    expect(screen.getByText(/Reading tool output — 98,000 tokens/)).toBeTruthy();
    expect(screen.queryByText(/your prompt/i)).toBeNull();
  });

  it('falls back to the generic rotation with no prefill payload', () => {
    render(<ThinkingIndicator />);
    expect(screen.queryByText(/Reading your prompt|Reading tool output/)).toBeNull();
  });

  it('a stall warning outranks the prefill notice too', () => {
    render(
      <ThinkingIndicator
        promptProcessing={{ promptTokens: 25_000, budgetMs: 600_000, source: 'prompt' }}
        stallWarning={{ retryInMs: 15_000, willRetry: false }}
      />,
    );
    expect(screen.getByText(/taking a while/i)).toBeTruthy();
    expect(screen.queryByText(/Reading your prompt/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live prefill progress: the label upgrades in place as llama.cpp reports in.
// ---------------------------------------------------------------------------
import { formatEta, prefillLabel } from '../src/renderer/components/ThinkingIndicator';

describe('formatEta — deliberately coarse', () => {
  it('says nothing when the wait is nearly over', () => {
    // A number here would just flicker on its way to zero.
    expect(formatEta(1_500)).toBeNull();
  });

  it('rounds seconds to 5s buckets — the projection is not precise enough for more', () => {
    expect(formatEta(9_894)).toBe('about 10s left');
    expect(formatEta(23_100)).toBe('about 25s left');
  });

  it('switches to minutes for long waits, pluralized', () => {
    expect(formatEta(61_000)).toBe('about 1 min left');
    expect(formatEta(200_000)).toBe('about 3 mins left');
  });

  it('returns null for missing or nonsense input rather than rendering NaN', () => {
    for (const v of [null, undefined, NaN, -5]) expect(formatEta(v as any)).toBeNull();
  });
});

describe('prefillLabel', () => {
  it('states the size when there is no live progress yet', () => {
    expect(prefillLabel({ promptTokens: 25_000, source: 'prompt' }))
      .toBe('Reading your prompt — 25,000 tokens…');
  });

  it('upgrades to a percentage once llama.cpp reports progress', () => {
    const label = prefillLabel({ promptTokens: 5_519, processed: 2_048, source: 'prompt', etaMs: 9_894 });
    expect(label).toContain('37% of 5,519 tokens');
    expect(label).toContain('about 10s left');
  });

  it('still names tool output correctly with live progress attached', () => {
    expect(prefillLabel({ promptTokens: 98_000, processed: 49_000, source: 'tool-output', etaMs: 30_000 }))
      .toContain('Reading tool output — 50% of 98,000 tokens');
  });

  it('omits the ETA when none can be projected', () => {
    const label = prefillLabel({ promptTokens: 5_519, processed: 0, source: 'prompt', etaMs: null });
    expect(label).toContain('0% of 5,519 tokens');
    expect(label).not.toContain('left');
  });

  it('never shows more than 100%', () => {
    expect(prefillLabel({ promptTokens: 100, processed: 130, source: 'prompt' })).toContain('100% of 100 tokens');
  });
});
