// @vitest-environment jsdom
/**
 * The chatsearch cards (ChatsearchFindCard / ChatsearchShowCard) have their own
 * unit tests in chatsearch-cards.test.tsx, driven with hand-built props. Those
 * tests never touch the WIRING: the two switches inside ToolBody.tsx and
 * ToolCard.tsx that decide "is this Bash call a chatsearch call" and swap in
 * the card instead of the plain shell view. ToolBody and ToolCard are two of
 * the most widely shared components in the app — a regression there would
 * silently affect every ordinary tool card, not just chatsearch's own. This
 * file drives real ToolCallState values through the real ToolBody/ToolCard so
 * that wiring is pinned, not just the cards it renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';
import { COPY, type ResolvedConversation } from '../src/shared/chatsearch-refs';

// Fixtures below are the same shape as chatsearch-refs-parser.test.ts's FIND_OUT
// / SHOW_OUT — byte-for-byte what chatsearch.js's formatRows()/cmdShow() print
// (two-space column gaps, uuid-first metadata line) — so the real parser this
// suite exercises (describeChatsearchCall, via ToolBody/ToolCard) actually
// recognizes them as chatsearch output, not a hand-simplified stand-in.
const FIND_CMD = `node "/home/x/.claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/skills/chatsearch/scripts/chatsearch.js" '{"cmd":"find","query":"sync"}'`;
const FIND_OUT = [
  'a3f2   2026-07-26  youcoded      ✓   Permission ask timeout         #perm #ui',
  '9c14   2026-07-22  youcoded-dev  ?†  Native runtime parity program  #native',
  '1b07f  ----------  my project    ○   Row with no known date',
].join('\n');
const SHOW_CMD = `node "/home/x/.claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/skills/chatsearch/scripts/chatsearch.js" '{"cmd":"show","id":"7736"}'`;
const SHOW_OUT = [
  '773634bb-621e-4d84-8d51-903093478ee8  Chat Search Workstream Status',
  'project:    youcoded-dev  (/home/destin/youcoded-dev)',
  'provider:   claude',
  'created:    2026-08-06T04:53:34.394Z',
].join('\n');
const ORDINARY_CMD = 'ls -la';

// Built as the REAL type, never `as ToolCallState` — a wrong status string
// (e.g. the plausible-looking typo 'completed') must fail to compile, not
// silently produce a tool that never renders as finished.
function finishedBash(command: string, response: string): ToolCallState {
  return { toolUseId: 't1', toolName: 'Bash', input: { command }, status: 'complete', response };
}

const okResult = (over: Partial<Extract<ResolvedConversation, { status: 'ok' }>> = {}): ResolvedConversation => ({
  status: 'ok', id: 'a3f2aaaa-0000-4000-8000-000000000000', provider: 'claude', title: 'Permission ask timeout',
  projectName: 'youcoded', originalPath: '/p/youcoded', lastActive: '2026-07-26T03:14:09.000Z', createdAt: '2026-07-25T18:02:11.000Z',
  tags: [], complete: true, tombstone: false, projectSlug: '-p-youcoded', projectPath: '/p/youcoded', missingProject: false, notSyncedYet: false, ...over,
});

beforeEach(() => {
  (window as any).claude = { chatsearch: { resolve: vi.fn() } };
});
// Several tests mount cards in the same run; without this a leftover DOM tree
// from one test makes the next test's queries find duplicates.
afterEach(cleanup);

describe('chatsearch wiring — ToolBody + ToolCard', () => {
  it('renders the find card (not the plain shell view) for a finished find call, and the collapsed header reads the chatsearch label', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [okResult(), okResult({ id: 'b', title: 'Native runtime parity program' }), okResult({ id: 'c', title: 'Row with no known date' })] });
    render(<ChatProvider><ToolCard tool={finishedBash(FIND_CMD, FIND_OUT)} sessionId="s1" /></ChatProvider>);
    // Header label: friendlyToolDisplay must read the chatsearch header text
    // (3 rows parsed from FIND_OUT), never the raw "Running node" shell label.
    expect(screen.getByText(COPY.headerFind(3))).toBeTruthy();
    expect(screen.queryByText(/Running node/)).toBeNull();
    // Body: the find card's own content — Preview/Resume buttons — is what
    // actually proves ToolBody picked the card over ShellView.
    await screen.findByText('Permission ask timeout');
    expect(screen.getAllByRole('button', { name: COPY.preview })).toHaveLength(3);
  });

  it('renders the show card for a finished show call', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [okResult({ id: '773634bb-621e-4d84-8d51-903093478ee8', title: 'Chat Search Workstream Status' })] });
    render(<ChatProvider><ToolCard tool={finishedBash(SHOW_CMD, SHOW_OUT)} sessionId="s1" /></ChatProvider>);
    expect(screen.getByText(COPY.headerShow)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Chat Search Workstream Status' })).toBeTruthy();
    expect(screen.getByRole('button', { name: COPY.preview })).toBeTruthy();
  });

  it('starts a chatsearch card expanded, while an ordinary Bash call in the same run still starts collapsed', () => {
    // Never resolves — this test only cares about the SYNCHRONOUS initial
    // expanded state, decided by ToolCard from the command shape alone
    // (isChatsearchCommand), before any resolve response can arrive.
    (window as any).claude.chatsearch.resolve.mockImplementation(() => new Promise(() => {}));
    render(<ChatProvider><ToolCard tool={finishedBash(FIND_CMD, FIND_OUT)} sessionId="s1" /></ChatProvider>);
    // Positive: the chatsearch card's body is already mounted with no click.
    expect(screen.getByTestId('tool-card-body')).toBeTruthy();

    cleanup();

    // Negative control, same test: an ordinary Bash call must NOT be expanded
    // by default — if this ever also passed, it'd mean the assertion above is
    // vacuous (ToolCard always starts expanded) rather than chatsearch-specific.
    render(<ChatProvider><ToolCard tool={finishedBash(ORDINARY_CMD, 'file1\nfile2')} sessionId="s2" /></ChatProvider>);
    expect(screen.queryByTestId('tool-card-body')).toBeNull();
  });

  it('renders the plain shell view with its normal header for an ordinary Bash call', () => {
    render(<ChatProvider><ToolCard tool={finishedBash(ORDINARY_CMD, 'file1\nfile2')} sessionId="s1" /></ChatProvider>);
    // Normal header: friendlyToolDisplay's non-chatsearch Bash branch.
    expect(screen.getByText('Running ls')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
    // Positive: the plain shell view's own content — the full command in a <pre>.
    expect(screen.getByText(ORDINARY_CMD)).toBeTruthy();
    // Negative control: chatsearch-only content must be absent here.
    expect(screen.queryByRole('button', { name: COPY.preview })).toBeNull();
  });

  it('falls back to the plain shell view when the resolve backend answers not-implemented-on-mobile (Android)', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: false, error: 'not-implemented-on-mobile' });
    render(<ChatProvider><ToolCard tool={finishedBash(FIND_CMD, FIND_OUT)} sessionId="s1" /></ChatProvider>);
    // Positive, BEFORE the resolve promise settles: the card view is up, with
    // its "Raw output" disclosure — the same raw command text sits nested
    // inside <details> here, so text presence alone can't prove the fallback;
    // the disclosure disappearing is what proves ToolBody actually swapped.
    expect(screen.getByText(COPY.rawOutput)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(COPY.rawOutput)).toBeNull());
    // Positive: the plain shell view is now the WHOLE body — same raw command,
    // just promoted out from behind the disclosure.
    expect(screen.getByText(FIND_CMD)).toBeTruthy();
    // Negative control, same test: the card's own actions must be gone.
    expect(screen.queryByRole('button', { name: COPY.preview })).toBeNull();
  });
});
