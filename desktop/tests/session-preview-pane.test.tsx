// @vitest-environment jsdom
// This repo defaults vitest to the 'node' environment per-file — jsdom is
// opt-in via this docblock (must be line 1), or `document`/`window` don't exist.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SessionPreviewPane from '../src/renderer/components/SessionPreviewPane';
import { COPY } from '../src/shared/chatsearch-refs';

// jsdom does not implement scrollIntoView; the ConversationTranscript this
// pane renders calls it to jump to the newest message. Every real browser has
// it — this is a test-environment gap (see tests/ui-primitives.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const msg = (seq: number) => ({ role: seq % 2 ? 'assistant' : 'user', content: `m${seq}`, timestamp: seq, seq, droppedToolCalls: 0 });
beforeEach(() => { (window as any).claude = { chatsearch: { read: vi.fn() } }; });

describe('SessionPreviewPane', () => {
  it('loads the newest slice and offers Load older while hasMore', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(58), msg(59)], hasMore: true });
    render(<SessionPreviewPane provider="claude" id="abc" title="T" onClose={() => {}} />);
    expect(await screen.findByText('m59')).toBeTruthy();
    expect((window as any).claude.chatsearch.read).toHaveBeenCalledWith({ provider: 'claude', id: 'abc', tail: 40 });
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(56), msg(57)], hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: COPY.loadOlder }));
    await waitFor(() => expect(screen.getByText('m56')).toBeTruthy());
    expect((window as any).claude.chatsearch.read).toHaveBeenLastCalledWith({ provider: 'claude', id: 'abc', tail: 40, before: 58 });
    expect(screen.queryByRole('button', { name: COPY.loadOlder })).toBeNull();
    expect(screen.getByText(new RegExp(COPY.startOfConversation))).toBeTruthy();
  });
  it('surfaces the real error and never renders an empty list as an empty conversation', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'EACCES: permission denied, open /x.jsonl' });
    render(<SessionPreviewPane provider="claude" id="abc" title="T" onClose={() => {}} />);
    expect(await screen.findByText(/EACCES: permission denied/)).toBeTruthy();
  });
  it('labels the lane for humans', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(1)], hasMore: false });
    render(<SessionPreviewPane provider="native" id="abc" title="T" onClose={() => {}} />);
    expect(await screen.findByText(/YouCoded assistant/)).toBeTruthy();
    expect(screen.queryByText(/\bnative\b/)).toBeNull();
  });
});
