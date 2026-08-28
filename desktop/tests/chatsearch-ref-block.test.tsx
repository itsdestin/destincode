// @vitest-environment jsdom
/**
 * The reference block: past conversations the assistant names inside its own
 * message. Not a tool — the assistant writes a fenced `conversations` block and
 * the renderer swaps it for a card of rows, which is why it works on both lanes
 * without the app handing Claude Code anything.
 *
 * Two halves are pinned here: the parser (pure, and fed model-written text, so
 * it must be forgiving without becoming credulous) and the markdown hook (which
 * must fire in a live assistant bubble and NOT in a previewed past conversation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import { SessionRefsEnabled } from '../src/renderer/components/session-refs-context';
import { parseConversationRefs, COPY, type ResolvedConversation } from '../src/shared/chatsearch-refs';

const ID = 'a3f2aaaa-0000-4000-8000-000000000000';
const ok = (over: Partial<Extract<ResolvedConversation, { status: 'ok' }>> = {}): ResolvedConversation => ({
  status: 'ok', id: ID, provider: 'claude', title: 'Permission ask timeout',
  projectName: 'youcoded', originalPath: '/p/youcoded', lastActive: '2026-07-26T03:14:09.000Z', createdAt: '2026-07-25T18:02:11.000Z',
  tags: [], complete: true, tombstone: false, projectSlug: '-p-youcoded', projectPath: '/p/youcoded',
  missingProject: false, notSyncedYet: false, ...over,
});

const FENCE = 'Here is what we settled:\n\n```conversations\na3f2\n9c14\n```\n\nAnd separately:';

beforeEach(() => {
  (window as any).claude = {
    chatsearch: { resolve: vi.fn().mockResolvedValue({ ok: true, results: [ok(), ok({ id: '9c14bbbb-0000-4000-8000-000000000000', title: 'Native runtime parity program' })] }) },
    tags: { list: vi.fn().mockResolvedValue([]) },
    on: {},
  };
});
afterEach(cleanup);

describe('parseConversationRefs', () => {
  it('reads one id per line', () => {
    expect(parseConversationRefs('a3f2\n9c14\n1b07')).toEqual(['a3f2', '9c14', '1b07']);
  });
  it('tolerates the shapes a model actually writes — bullets, commas, several per line', () => {
    expect(parseConversationRefs('- a3f2\n* 9c14, 1b07\n  5e11 7a21')).toEqual(['a3f2', '9c14', '1b07', '5e11', '7a21']);
  });
  it('drops anything that is not id-shaped rather than passing it to a lookup', () => {
    // The block is written by a model: it is input, not a contract.
    expect(parseConversationRefs('a3f2\nsee the notes\n../etc/passwd\nzzzz')).toEqual(['a3f2']);
  });
  it('dedupes, so one conversation named twice is one row', () => {
    expect(parseConversationRefs('a3f2\na3f2')).toEqual(['a3f2']);
  });
  it('lowercases, because an id is hex either way', () => {
    expect(parseConversationRefs('A3F2')).toEqual(['a3f2']);
  });
});

describe('the fence inside a message', () => {
  it('becomes a reference block in a live assistant bubble, and the prose around it survives', async () => {
    render(
      <SessionRefsEnabled.Provider value={true}>
        <MarkdownContent content={FENCE} />
      </SessionRefsEnabled.Provider>,
    );
    expect(await screen.findByText('Permission ask timeout')).toBeTruthy();
    expect(screen.getByText('Native runtime parity program')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: COPY.preview })).toHaveLength(2);
    // The sentences on either side are what introduce the block — they must not
    // be swallowed with it.
    expect(screen.getByText(/Here is what we settled/)).toBeTruthy();
    expect(screen.getByText(/And separately/)).toBeTruthy();
  });

  it('stays plain text where the block is not enabled — a previewed past conversation', () => {
    // Ids from another device would resolve to a card of dead rows, so a
    // transcript renders the fence as what it literally is.
    render(<MarkdownContent content={FENCE} />);
    expect(screen.queryByRole('button', { name: COPY.preview })).toBeNull();
    expect(screen.getByText(/a3f2/)).toBeTruthy();
    expect((window as any).claude.chatsearch.resolve).not.toHaveBeenCalled();
  });

  it('an ordinary code fence is still code, not a reference block', () => {
    render(
      <SessionRefsEnabled.Provider value={true}>
        <MarkdownContent content={'```ts\nconst a3f2 = 1;\n```'} />
      </SessionRefsEnabled.Provider>,
    );
    expect(screen.queryByRole('button', { name: COPY.preview })).toBeNull();
    expect((window as any).claude.chatsearch.resolve).not.toHaveBeenCalled();
  });

  it('renders nothing at all when the backend cannot resolve (Android)', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: false, error: 'not-implemented-on-mobile' });
    render(
      <SessionRefsEnabled.Provider value={true}>
        <MarkdownContent content={FENCE} />
      </SessionRefsEnabled.Provider>,
    );
    // The prose stands on its own; an empty bordered box would read as broken.
    expect(await screen.findByText(/Here is what we settled/)).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByText(COPY.lookingUp(2))).toBeNull());
    expect(screen.queryByRole('button', { name: COPY.preview })).toBeNull();
  });
});
