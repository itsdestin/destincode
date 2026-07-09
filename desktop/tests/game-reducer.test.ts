import { describe, it, expect } from 'vitest';
import { gameReducer } from '../src/renderer/state/game-reducer';
import { createInitialGameState, GameState, OnlineUser } from '../src/renderer/state/game-types';

// Accounts Phase 2 (Task 7): presence identity is the ACCOUNT now — keyed by id,
// display name is the visible tag. These pin the account-keyed presence/challenge
// reducer behavior and that the retired slow-connect action type is gone.

function withUsers(users: OnlineUser[]): GameState {
  return { ...createInitialGameState(), onlineUsers: users };
}

const alice: OnlineUser = { id: 'github:1', name: 'Alice', handle: 'alice', status: 'idle' };
const bob: OnlineUser = { id: 'github:2', name: 'Bob', handle: null, status: 'idle' };

describe('gameReducer — presence (account-keyed)', () => {
  it('PARTY_CONNECTED sets the visible tag and moves to the lobby', () => {
    const next = gameReducer(createInitialGameState(), { type: 'PARTY_CONNECTED', username: 'Alice' });
    expect(next.connected).toBe(true);
    expect(next.username).toBe('Alice');
    expect(next.screen).toBe('lobby');
    expect(next.partyError).toBeNull();
  });

  it('PARTY_CONNECTED preserves an in-progress game screen (reload-replay broadcast)', () => {
    // The platform layer's renderer-reload replay re-emits a synthetic
    // 'connected' to ALL windows when any one of them reconnects — a second
    // window mid-game must not be yanked back to the lobby.
    for (const screen of ['waiting', 'joining', 'playing', 'game-over'] as const) {
      const next = gameReducer({ ...createInitialGameState(), screen }, { type: 'PARTY_CONNECTED', username: 'Alice' });
      expect(next.screen).toBe(screen);
      expect(next.connected).toBe(true);
    }
  });

  it('PRESENCE_UPDATE replaces the whole list', () => {
    const next = gameReducer(withUsers([alice]), { type: 'PRESENCE_UPDATE', online: [bob] });
    expect(next.onlineUsers).toEqual([bob]);
  });

  it('PRESENCE_UPDATE ignores a malformed payload (keeps existing list)', () => {
    // A malformed frame must never wipe onlineUsers to undefined — later
    // USER_* reducers call .filter/.map on it.
    const next = gameReducer(withUsers([alice]), { type: 'PRESENCE_UPDATE', online: undefined as any });
    expect(next.onlineUsers).toEqual([alice]);
  });

  it('USER_JOINED keys on id (replaces an existing entry for the same id)', () => {
    const updatedAlice: OnlineUser = { ...alice, status: 'in-game' };
    const next = gameReducer(withUsers([alice]), { type: 'USER_JOINED', user: updatedAlice });
    expect(next.onlineUsers).toHaveLength(1);
    expect(next.onlineUsers[0].status).toBe('in-game');
  });

  it('USER_JOINED appends a new account', () => {
    const next = gameReducer(withUsers([alice]), { type: 'USER_JOINED', user: bob });
    expect(next.onlineUsers.map(u => u.id)).toEqual(['github:1', 'github:2']);
  });

  it('USER_LEFT removes by id', () => {
    const next = gameReducer(withUsers([alice, bob]), { type: 'USER_LEFT', id: 'github:1' });
    expect(next.onlineUsers.map(u => u.id)).toEqual(['github:2']);
  });

  it('USER_STATUS updates status by id', () => {
    const next = gameReducer(withUsers([alice, bob]), { type: 'USER_STATUS', id: 'github:2', status: 'in-game' });
    expect(next.onlineUsers.find(u => u.id === 'github:2')?.status).toBe('in-game');
    expect(next.onlineUsers.find(u => u.id === 'github:1')?.status).toBe('idle');
  });
});

describe('gameReducer — challenges (account identity)', () => {
  it('CHALLENGE_RECEIVED stores the full card {id, name, handle}, sets the code, and opens the panel', () => {
    const next = gameReducer(createInitialGameState(), {
      type: 'CHALLENGE_RECEIVED',
      from: { id: 'github:2', name: 'Bob', handle: 'bob' },
      gameType: 'connect-four',
      code: 'ABC123',
    });
    // handle is carried through (Task 8's friends UI renders @handle).
    expect(next.challengeFrom).toEqual({ id: 'github:2', name: 'Bob', handle: 'bob' });
    expect(next.challengeCode).toBe('ABC123');
    expect(next.panelOpen).toBe(true);
  });

  it('CHALLENGE_DECLINED stores the full card {id, name, handle} of the decliner', () => {
    const next = gameReducer(createInitialGameState(), { type: 'CHALLENGE_DECLINED', by: { id: 'github:2', name: 'Bob', handle: null } });
    expect(next.challengeDeclinedBy).toEqual({ id: 'github:2', name: 'Bob', handle: null });
  });

  it('CHALLENGE_FAILED resolves the account id to a visible name via the presence list', () => {
    const state: GameState = { ...withUsers([bob]), screen: 'waiting' };
    const next = gameReducer(state, { type: 'CHALLENGE_FAILED', target: 'github:2' });
    expect(next.screen).toBe('lobby');
    expect(next.partyError).toBe('Bob is no longer online.');
  });

  it('CLEAR_CHALLENGE clears all challenge fields', () => {
    const state: GameState = {
      ...createInitialGameState(),
      challengeFrom: { id: 'github:2', name: 'Bob', handle: 'bob' },
      challengeCode: 'ABC123',
      challengeDeclinedBy: { id: 'github:3', name: 'Cara', handle: null },
    };
    const next = gameReducer(state, { type: 'CLEAR_CHALLENGE' });
    expect(next.challengeFrom).toBeNull();
    expect(next.challengeCode).toBeNull();
    expect(next.challengeDeclinedBy).toBeNull();
  });
});

describe('gameReducer — disconnect semantics', () => {
  it('PARTY_DISCONNECTED with no code is silent (intentional local disconnect)', () => {
    const next = gameReducer({ ...withUsers([alice]), connected: true }, { type: 'PARTY_DISCONNECTED' });
    expect(next.connected).toBe(false);
    expect(next.onlineUsers).toEqual([]);
    expect(next.partyError).toBeNull();
  });

  it('PARTY_DISCONNECTED with a code surfaces an error (real drop)', () => {
    const next = gameReducer({ ...withUsers([alice]), connected: true }, { type: 'PARTY_DISCONNECTED', code: 1006 });
    expect(next.connected).toBe(false);
    expect(next.partyError).toContain('1006');
  });
});

describe('gameReducer — retired action types', () => {
  it('PARTY_SLOW_CONNECT is no longer part of the action union', () => {
    // @ts-expect-error — PARTY_SLOW_CONNECT was deleted with the PartyKit lobby (Task 7).
    const next = gameReducer(createInitialGameState(), { type: 'PARTY_SLOW_CONNECT', hint: 'x' });
    // Unknown action → default branch returns state unchanged.
    expect(next).toEqual(createInitialGameState());
  });
});
