// @vitest-environment jsdom
// Paged history (perf cycle 2): ChatView fetches the next OLDER page when the
// top of the list scrolls into view. Scaffolding mirrors
// chatview-empty-response-gate.test.tsx (the established ChatView pattern).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

function emptySessionState() {
  return {
    timeline: [] as any[],
    queuedMessages: [] as any[],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    activeTurnToolIds: new Set(),
    isThinking: false,
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 0,
    lastOutputAt: 0,
    modelState: 'idle',
    modelInfo: null,
    modelLoadedBytes: 0,
    modelEverResident: false,
    history: { cursor: null, hasMore: false, loading: false },
  };
}

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: null as any }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => mocks.dispatch,
}));

vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({ state: { drawerOpenBySession: {}, drawerExpanded: false }, dispatch: vi.fn() }),
}));

// Fires the moment anything is observed — the sentinel is "in view" on mount.
const observed: Element[] = [];
(globalThis as any).IntersectionObserver = class {
  cb: (entries: any[]) => void;
  constructor(cb: (entries: any[]) => void) { this.cb = cb; }
  observe(el: Element) { observed.push(el); this.cb([{ isIntersecting: true, target: el }]); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
};

import ChatView from '../src/renderer/components/ChatView';

function renderWith(history: { cursor: any; hasMore: boolean; loading: boolean }) {
  mocks.state = { ...emptySessionState(), timeline: [{ kind: 'user', message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1 } }], history };
  return render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
}

let requestPage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  observed.length = 0;
  mocks.dispatch = vi.fn();
  requestPage = vi.fn().mockResolvedValue({ events: [], cursor: null, hasMore: false });
  (window as any).claude = { detach: { requestTranscriptPage: requestPage } };
});
afterEach(() => cleanup());

describe('ChatView history sentinel', () => {
  it('fetches the next older page when the top sentinel comes into view', async () => {
    renderWith({ cursor: { path: 'p', offset: 100, sizeAtRead: 900 }, hasMore: true, loading: false });
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledTimes(1));
    expect(requestPage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      beforeCursor: { path: 'p', offset: 100, sizeAtRead: 900 },
    }));
    // It announces the request first, so a second sentinel hit can't double-fetch.
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'HISTORY_PAGE_REQUESTED', sessionId: 's1' });
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'HISTORY_PAGE_LOADED', sessionId: 's1' }),
    ));
  });

  it('renders no sentinel once the beginning of the conversation is on screen', () => {
    const { container } = renderWith({ cursor: null, hasMore: false, loading: false });
    expect(container.querySelector('[data-history-sentinel]')).toBeNull();
    expect(requestPage).not.toHaveBeenCalled();
  });

  it('does not fetch while a page is already in flight', () => {
    renderWith({ cursor: { path: 'p', offset: 100, sizeAtRead: 900 }, hasMore: true, loading: true });
    expect(requestPage).not.toHaveBeenCalled();
  });

  it('a failed fetch clears loading so the next scroll can retry', async () => {
    requestPage.mockRejectedValue(new Error('nope'));
    renderWith({ cursor: { path: 'p', offset: 100, sizeAtRead: 900 }, hasMore: true, loading: false });
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'HISTORY_PAGE_FAILED', sessionId: 's1' }));
  });

  it('the retired "See previous messages" button is gone', () => {
    const { container } = renderWith({ cursor: null, hasMore: false, loading: false });
    expect(container.textContent).not.toContain('See previous messages');
  });
});
