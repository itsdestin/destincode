import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/main/logger', () => ({ log: vi.fn(), rotateLog: vi.fn() }));

import { makeClearSessionOn401 } from '../src/main/handler-utils';
import { log } from '../src/main/logger';
import type { MarketplaceAuthStore } from '../src/main/marketplace-auth-store';

/**
 * The 401 decorator is what signs the account out when the server stops
 * recognising a session. Clearing the token is correct — leaving it would
 * strand the user "signed in" with every call failing. Doing it SILENTLY was
 * the bug: presence drops with the session, friends see the user offline
 * forever, and nothing anywhere recorded that it happened.
 */
function fakeStore(token: string | null) {
  return {
    token,
    getToken() { return this.token; },
    signOut() { this.token = null; },
  };
}

const asStore = (s: ReturnType<typeof fakeStore>) => s as unknown as MarketplaceAuthStore;

describe('makeClearSessionOn401', () => {
  beforeEach(() => vi.mocked(log).mockClear());

  it('clears the session on a 401 and says so, naming the surface and the SERVER\'s reason', () => {
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'social');

    const result = clear({ ok: false, status: 401, message: 'invalid token' });

    expect(store.token).toBeNull();
    expect(result).toEqual({ ok: false, status: 401, message: 'invalid token' });
    expect(log).toHaveBeenCalledTimes(1);
    const [level, component, , extra] = vi.mocked(log).mock.calls[0];
    expect(level).toBe('WARN');
    expect(component).toBe('Auth');
    // The surface tells you WHICH subsystem 401'd without labelling all 19
    // call sites; the message is the server's own, never a guess of ours
    // (docs/error-message-standards.md).
    expect(extra).toMatchObject({ surface: 'social', serverMessage: 'invalid token' });
  });

  it('logs ONCE for a burst, because signOut is idempotent', () => {
    // Several in-flight calls can 401 together. That is one sign-out event, not
    // four, and the log should read that way.
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'marketplace');

    for (let i = 0; i < 4; i++) clear({ ok: false, status: 401, message: 'expired' });

    expect(store.token).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('leaves every other status alone and stays quiet', () => {
    // 403 is the install gate, 404 not-found, 429 caps, 0 a network/parse
    // failure. None of them mean "the server forgot who you are".
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'arcade');

    for (const status of [0, 403, 404, 429, 500]) {
      clear({ ok: false, status, message: 'nope' });
    }

    expect(store.token).toBe('tok');
    expect(log).not.toHaveBeenCalled();
  });

  it('passes a success through untouched', () => {
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'social');
    expect(clear({ ok: true, value: 42 })).toEqual({ ok: true, value: 42 });
    expect(store.token).toBe('tok');
    expect(log).not.toHaveBeenCalled();
  });
});
