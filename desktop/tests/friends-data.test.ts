// friends-data.test.ts
// Unit tests for the pure friends-list helpers (mergeFriends / statusLabel).
// These have no React or IPC dependencies — they take plain data + an injected
// `nowMs` so the coarsening ladder is deterministic (no wall-clock coupling).

import { describe, it, expect } from 'vitest';
import { mergeFriends, statusLabel, type FriendRowData } from '../src/renderer/components/game/friends-data';
import type { OnlineUser } from '../src/renderer/state/game-types';

// A realistic fixed epoch so the boundary math reads clearly.
const NOW_MS = 1_600_000_000_000;
const NOW_SEC = NOW_MS / 1000;

// Build a server FriendRow-ish record (the mergeFriends input shape).
function friend(over: Partial<{
  id: string; display_name: string; handle: string | null; avatar_url: string | null; last_seen_at: number | null;
}> = {}) {
  return {
    id: over.id ?? 'github:1',
    display_name: over.display_name ?? 'Alice',
    handle: over.handle ?? 'alice',
    avatar_url: over.avatar_url ?? null,
    last_seen_at: over.last_seen_at ?? null,
  };
}

function onlineUser(over: Partial<OnlineUser> = {}): OnlineUser {
  return {
    id: over.id ?? 'github:1',
    name: over.name ?? 'Alice',
    handle: over.handle ?? 'alice',
    status: over.status ?? 'idle',
  };
}

// Build a merged FriendRowData directly for statusLabel tests.
function row(over: Partial<FriendRowData> = {}): FriendRowData {
  return {
    id: over.id ?? 'github:1',
    name: over.name ?? 'Alice',
    handle: over.handle ?? 'alice',
    avatarUrl: over.avatarUrl ?? null,
    lastSeenAt: over.lastSeenAt ?? null,
    online: over.online ?? null,
  };
}

describe('mergeFriends', () => {
  it('attaches live presence entries by id', () => {
    const merged = mergeFriends(
      [friend({ id: 'github:1', display_name: 'Alice' })],
      [onlineUser({ id: 'github:1', status: 'in-game' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].online).toEqual(onlineUser({ id: 'github:1', status: 'in-game' }));
  });

  it('maps snake_case server fields to the camelCase row shape', () => {
    const merged = mergeFriends(
      [friend({ id: 'github:9', display_name: 'Zoe', handle: 'zoe', avatar_url: 'http://a', last_seen_at: 123 })],
      [],
    );
    expect(merged[0]).toEqual({
      id: 'github:9', name: 'Zoe', handle: 'zoe', avatarUrl: 'http://a', lastSeenAt: 123, online: null,
    });
  });

  it('sorts online friends before offline ones', () => {
    const merged = mergeFriends(
      [
        friend({ id: 'github:1', display_name: 'Alice' }),   // offline
        friend({ id: 'github:2', display_name: 'Bob' }),     // online
      ],
      [onlineUser({ id: 'github:2', name: 'Bob' })],
    );
    expect(merged.map((r) => r.id)).toEqual(['github:2', 'github:1']);
  });

  it('breaks ties within the same online-ness by name (locale compare)', () => {
    const merged = mergeFriends(
      [
        friend({ id: 'github:3', display_name: 'Charlie' }),
        friend({ id: 'github:1', display_name: 'Alice' }),
        friend({ id: 'github:2', display_name: 'Bob' }),
      ],
      [], // all offline
    );
    expect(merged.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('online-first AND name-sorted within each group', () => {
    const merged = mergeFriends(
      [
        friend({ id: 'github:1', display_name: 'Yara' }),   // online
        friend({ id: 'github:2', display_name: 'Xander' }), // online
        friend({ id: 'github:3', display_name: 'Bea' }),    // offline
        friend({ id: 'github:4', display_name: 'Ana' }),    // offline
      ],
      [onlineUser({ id: 'github:1', name: 'Yara' }), onlineUser({ id: 'github:2', name: 'Xander' })],
    );
    // Xander, Yara online (name-sorted), then Ana, Bea offline (name-sorted).
    expect(merged.map((r) => r.name)).toEqual(['Xander', 'Yara', 'Ana', 'Bea']);
  });
});

describe('statusLabel — live presence wins', () => {
  it("returns 'Online' for an idle live entry regardless of lastSeenAt", () => {
    expect(statusLabel(row({ online: onlineUser({ status: 'idle' }), lastSeenAt: 0 }), NOW_MS)).toBe('Online');
  });

  it("returns 'In game' for an in-game live entry", () => {
    expect(statusLabel(row({ online: onlineUser({ status: 'in-game' }) }), NOW_MS)).toBe('In game');
  });
});

describe('statusLabel — offline coarsening ladder', () => {
  it("returns 'Offline' when there is no lastSeenAt", () => {
    expect(statusLabel(row({ online: null, lastSeenAt: null }), NOW_MS)).toBe('Offline');
  });

  it("under 2 minutes → 'Active just now'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 60 }), NOW_MS)).toBe('Active just now'); // 1m
  });

  it("boundary: exactly 2 minutes → 'Last seen 2m ago'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 120 }), NOW_MS)).toBe('Last seen 2m ago');
  });

  it("59 minutes → 'Last seen 59m ago'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 59 * 60 }), NOW_MS)).toBe('Last seen 59m ago');
  });

  it("boundary: exactly 60 minutes → 'Last seen 1h ago'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 60 * 60 }), NOW_MS)).toBe('Last seen 1h ago');
  });

  it("23 hours → 'Last seen 23h ago'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 23 * 3600 }), NOW_MS)).toBe('Last seen 23h ago');
  });

  it("boundary: exactly 24 hours → 'Last seen 1d ago'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 24 * 3600 }), NOW_MS)).toBe('Last seen 1d ago');
  });

  it("6 days → 'Last seen 6d ago'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC - 6 * 24 * 3600 }), NOW_MS)).toBe('Last seen 6d ago');
  });

  it("boundary: exactly 7 days → falls back to a locale date string", () => {
    const last = NOW_SEC - 7 * 24 * 3600;
    expect(statusLabel(row({ lastSeenAt: last }), NOW_MS)).toBe(
      `Last seen ${new Date(last * 1000).toLocaleDateString()}`,
    );
  });
});

describe('statusLabel — negative clock skew', () => {
  it("lastSeenAt in the future clamps to 'Active just now'", () => {
    expect(statusLabel(row({ lastSeenAt: NOW_SEC + 3600 }), NOW_MS)).toBe('Active just now');
  });
});
