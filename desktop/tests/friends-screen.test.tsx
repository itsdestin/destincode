// @vitest-environment jsdom
// friends-screen.test.tsx
// Render tests for the friends list UI (FriendsScreen inside GameLobby.tsx).
// game-context and account-context are mocked (same style as use-presence.test.tsx)
// so we can drive game state + signed-in status directly; window.claude.social is
// a vi.fn mock so we observe exactly which social IPC calls the UI makes.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Hoisted shared handles the mock factories close over.
const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    connected: true,
    partyError: null as string | null,
    username: 'Me',
    onlineUsers: [] as Array<{ id: string; name: string; handle: string | null; status: 'idle' | 'in-game' }>,
    screen: 'lobby' as string,
    challengeFrom: null as any,
    challengeDeclinedBy: null as any,
    challengeCode: null as string | null,
  },
}));

vi.mock('../src/renderer/state/game-context', () => ({
  useGameState: () => h.state,
  useGameDispatch: () => h.dispatch,
}));
vi.mock('../src/renderer/state/account-context', () => ({
  useAccount: () => ({ signedIn: true, signInPending: false, signInError: null, startSignIn: vi.fn() }),
}));

import GameLobby from '../src/renderer/components/game/GameLobby';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const err = (status: number, message = 'nope') => ({ ok: false as const, status, message });

// A no-op connection; challengePlayer is spied where a test needs it.
function makeConnection(over: Record<string, any> = {}) {
  return {
    createGame: vi.fn(),
    joinGame: vi.fn(),
    makeMove: vi.fn(),
    sendChat: vi.fn(),
    requestRematch: vi.fn(),
    leaveGame: vi.fn(),
    challengePlayer: vi.fn(),
    respondToChallenge: vi.fn(),
    reconnectLobby: vi.fn(),
    ...over,
  } as any;
}

function makeSocial(over: Record<string, any> = {}) {
  return {
    listFriends: vi.fn().mockResolvedValue(ok([])),
    listRequests: vi.fn().mockResolvedValue(ok({ incoming: [], outgoing: [] })),
    sendRequest: vi.fn().mockResolvedValue(ok({ status: 'pending' })),
    acceptRequest: vi.fn().mockResolvedValue(ok(undefined)),
    declineRequest: vi.fn().mockResolvedValue(ok(undefined)),
    cancelRequest: vi.fn().mockResolvedValue(ok(undefined)),
    unfriend: vi.fn().mockResolvedValue(ok(undefined)),
    block: vi.fn().mockResolvedValue(ok(undefined)),
    ...over,
  };
}

beforeEach(() => {
  h.dispatch.mockClear();
  h.state.onlineUsers = [];
  h.state.username = 'Me';
  h.state.challengeFrom = null;
  h.state.challengeDeclinedBy = null;
  (window as any).claude = { social: makeSocial() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const friend = (over: Partial<{ id: string; display_name: string; handle: string | null; last_seen_at: number | null }> = {}) => ({
  id: over.id ?? 'github:1',
  display_name: over.display_name ?? 'Alice',
  handle: over.handle ?? 'alice',
  avatar_url: null,
  last_seen_at: over.last_seen_at ?? null,
  created_at: 0,
});

describe('FriendsScreen — friends list', () => {
  it('renders merged rows online-first with plain-word statuses', async () => {
    // Alice offline, Bob online (live presence). mergeFriends should put Bob first.
    h.state.onlineUsers = [{ id: 'github:2', name: 'Bob', handle: 'bob', status: 'idle' }];
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([
        friend({ id: 'github:1', display_name: 'Alice', handle: 'alice', last_seen_at: null }),
        friend({ id: 'github:2', display_name: 'Bob', handle: 'bob' }),
      ])),
    });

    const { findByText, getByText } = render(<GameLobby connection={makeConnection()} />);

    // Wait for refresh() to populate the list.
    await findByText('Alice');
    expect(getByText('Bob')).toBeTruthy();
    // Word statuses — never glyphs.
    expect(getByText('Online')).toBeTruthy();   // Bob (live presence)
    expect(getByText('Offline')).toBeTruthy();  // Alice (no lastSeenAt)

    // Online-first ordering: Bob's row precedes Alice's in the DOM.
    const bobIdx = getByText('Bob').compareDocumentPosition(getByText('Alice'));
    // FOLLOWING (4) means Alice comes after Bob.
    expect(bobIdx & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows Challenge only on online rows', async () => {
    h.state.onlineUsers = [{ id: 'github:2', name: 'Bob', handle: 'bob', status: 'idle' }];
    const challengePlayer = vi.fn();
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([
        friend({ id: 'github:1', display_name: 'Alice', last_seen_at: null }),
        friend({ id: 'github:2', display_name: 'Bob', handle: 'bob' }),
      ])),
    });

    const { findAllByText } = render(<GameLobby connection={makeConnection({ challengePlayer })} />);

    // Exactly one Challenge button (Bob, the only online friend).
    const buttons = await findAllByText('Challenge');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(challengePlayer).toHaveBeenCalledWith('github:2');
  });
});

describe('FriendsScreen — add a friend', () => {
  it('maps a 404 to "No one has that handle"', async () => {
    const sendRequest = vi.fn().mockResolvedValue(err(404));
    (window as any).claude.social = makeSocial({ sendRequest });

    const { findByPlaceholderText, getByText } = render(<GameLobby connection={makeConnection()} />);
    const input = (await findByPlaceholderText("friend's handle")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'ghost' } });
    fireEvent.click(getByText('Send request'));

    await waitFor(() => expect(getByText('No one has that handle')).toBeTruthy());
    expect(sendRequest).toHaveBeenCalledWith('ghost');
  });

  it('lowercases the handle as the user types', async () => {
    const { findByPlaceholderText } = render(<GameLobby connection={makeConnection()} />);
    const input = (await findByPlaceholderText("friend's handle")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AlIcE' } });
    expect(input.value).toBe('alice');
  });
});

describe('FriendsScreen — block is consequence-gated', () => {
  it('requires the confirm step before calling block()', async () => {
    const blockFn = vi.fn().mockResolvedValue(ok(undefined));
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend({ id: 'github:1', display_name: 'Alice', handle: 'alice' })])),
      block: blockFn,
    });

    const { findByLabelText, getByRole, getByText, queryByText } = render(<GameLobby connection={makeConnection()} />);

    // Open the row menu.
    const menuBtn = await findByLabelText('Friend options');
    fireEvent.click(menuBtn);

    // The menu shows Unfriend + Block; consequence copy is NOT yet visible.
    expect(getByText('Unfriend')).toBeTruthy();
    expect(queryByText(/Blocking removes this friend/)).toBeNull();

    // Click the Block menu item → swaps to the confirm; block() not called yet.
    fireEvent.click(getByRole('menuitem', { name: 'Block' }));
    expect(getByText(/Blocking removes this friend/)).toBeTruthy();
    expect(blockFn).not.toHaveBeenCalled();

    // Confirm — now block() fires with the account id.
    fireEvent.click(getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(blockFn).toHaveBeenCalledWith('github:1'));
  });
});
