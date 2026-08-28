// @vitest-environment jsdom
// This repo defaults vitest to the 'node' environment per-file — jsdom is
// opt-in via this docblock (must be line 1), or `document`/`window` don't exist.
//
// Regression guard for Task 5's extraction: ConversationPreview used to render
// its own bubble list inline; that list moved into the shared
// ConversationTranscript component. No test rendered ConversationPreview
// itself before this file — the "18 related tests passed" at extraction time
// were unrelated files swept in by the import graph, not a guard on this
// component. This pins that the extraction didn't silently drop behaviour.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConversationPreview } from '../src/renderer/components/project-view/ConversationPreview';
import type { PastSession } from '../src/shared/types';

// jsdom does not implement scrollIntoView; the ConversationTranscript this
// component renders calls it to jump to the newest message. Every real
// browser has it — this is a test-environment gap (see tests/ui-primitives.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const session: PastSession = {
  sessionId: 'sess-1',
  name: 'Fix the sync bug',
  projectSlug: 'proj',
  projectPath: '/home/user/proj',
  lastModified: Date.now(),
  size: 1234,
};

beforeEach(() => {
  (window as any).claude = { project: { conversationHistory: vi.fn() } };
});

describe('ConversationPreview', () => {
  it('renders the bubble list from conversation history and shows the truncation hint when the history is a preview slice', async () => {
    (window as any).claude.project.conversationHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { role: 'user', content: 'why is sync broken', timestamp: 1 },
        { role: 'assistant', content: 'checking the logs now', timestamp: 2 },
      ],
    });
    render(<ConversationPreview project={{ path: '/home/user/proj' }} session={session} onClose={() => {}} onResume={() => {}} />);

    expect(await screen.findByText('why is sync broken')).toBeTruthy();
    expect(screen.getByText('checking the logs now')).toBeTruthy();
    // Positive control for the "no hint on a complete transcript" case below:
    // a 2-message, non-`all` response IS a preview slice, so the hint shows.
    expect(screen.getByText(/showing the last 2 messages/)).toBeTruthy();
  });

  it('does not show the truncation hint once the full transcript is loaded', async () => {
    (window as any).claude.project.conversationHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { role: 'user', content: 'why is sync broken', timestamp: 1 },
        { role: 'assistant', content: 'checking the logs now', timestamp: 2 },
      ],
    });
    render(<ConversationPreview project={{ path: '/home/user/proj' }} session={session} onClose={() => {}} onResume={() => {}} />);
    expect(await screen.findByText('why is sync broken')).toBeTruthy();
    expect(screen.getByText(/showing the last 2 messages/)).toBeTruthy(); // pre-state, so the transition below is meaningful

    (window as any).claude.project.conversationHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { role: 'user', content: 'why is sync broken', timestamp: 1 },
        { role: 'assistant', content: 'checking the logs now', timestamp: 2 },
        { role: 'assistant', content: 'found it — stale lock file', timestamp: 3 },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open full transcript' }));

    await waitFor(() => expect(screen.getByText('found it — stale lock file')).toBeTruthy());
    expect(screen.queryByText(/showing the last/)).toBeNull();
  });
});
