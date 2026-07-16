import { describe, it, expect } from 'vitest';
import { SearchKeyStore } from '../src/main/harness/search/search-key-store';

// In-memory SecretsStore stand-in: mirrors the real signatures we use —
// set(plaintext, existingRef?) reuses the ref for rotation, has()/get()/delete()
// operate on the ref → plaintext map. `m` is exposed so tests can assert the
// number of stored ciphertext entries directly.
function fakeSecrets() {
  const m = new Map<string, string>();
  let n = 0;
  return {
    m,
    async set(plaintext: string, existingRef?: string) {
      const ref = existingRef ?? `ref-${++n}`;
      m.set(ref, plaintext);
      return ref;
    },
    async get(ref: string) {
      return m.get(ref) ?? null;
    },
    async delete(ref: string) {
      m.delete(ref);
    },
    has(ref: string | undefined) {
      return !!ref && m.has(ref);
    },
  };
}

// In-memory NativeHome stand-in: implements ONLY the two methods SearchKeyStore
// uses — readJson (synchronous; null when absent) and mutateJson (async
// read-modify-write). JSON round-trips on read AND inside mutate so callers can
// never mutate our stored object by reference — same isolation the real
// NativeHome gets for free by re-reading the file from disk each call.
function fakeHome() {
  return fakeHomeSeeded(null);
}
function fakeHomeSeeded(initial: unknown) {
  let store: unknown = initial;
  const clone = (v: unknown) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    readJson(_rel: string): unknown | null {
      return clone(store);
    },
    async mutateJson(_rel: string, mutate: (current: unknown | null) => unknown): Promise<void> {
      store = mutate(clone(store));
    },
  };
}

describe('SearchKeyStore', () => {
  it('stores a key and reports hasKey', async () => {
    const s = new SearchKeyStore(fakeHome(), fakeSecrets() as any);
    await s.setKey('tavily', 'tvly-123');
    expect((await s.list()).find((p) => p.id === 'tavily')?.hasKey).toBe(true);
    expect(await s.getKey('tavily')).toBe('tvly-123');
    expect(await s.getKey('exa')).toBeNull();
  });
  it('rotates in place (same secretRef reused)', async () => {
    const secrets = fakeSecrets();
    const s = new SearchKeyStore(fakeHome(), secrets as any);
    await s.setKey('exa', 'old');
    await s.setKey('exa', 'new');
    expect(secrets.m.size).toBe(1);
    expect(await s.getKey('exa')).toBe('new');
  });
  it('removeKey deletes both the ref and the ciphertext', async () => {
    const secrets = fakeSecrets();
    const s = new SearchKeyStore(fakeHome(), secrets as any);
    await s.setKey('tavily', 'k');
    await s.removeKey('tavily');
    expect(secrets.m.size).toBe(0);
    expect(await s.getKey('tavily')).toBeNull();
  });
  it('tolerates a wrong-shape file', async () => {
    const s = new SearchKeyStore(fakeHomeSeeded({ garbage: true }), fakeSecrets() as any);
    expect(await s.list()).toHaveLength(2); // tavily + exa rows, hasKey false
  });
});
