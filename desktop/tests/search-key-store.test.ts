import { describe, it, expect } from 'vitest';
import { SearchKeyStore } from '../src/main/harness/search/search-key-store';
import type { NativeHomeLike, SecretsLike } from '../src/main/harness/search/search-key-store';
import type { NativeHome } from '../src/main/native-home';
import type { SecretsStore } from '../src/main/providers/secrets-store';

// Interface-drift guard: if NativeHome or SecretsStore ever changes a signature
// SearchKeyStore's structural interfaces rely on, these assignments stop
// compiling and `npx tsc --noEmit` fails — catching the drift before runtime.
const _homeDrift: NativeHomeLike = null as unknown as NativeHome;
const _secretsDrift: SecretsLike = null as unknown as SecretsStore;
void _homeDrift;
void _secretsDrift;

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
  // The POINT of the secretRef split: a synced ~/.youcoded/ carries the pointer
  // but the machine-bound ciphertext never leaves userData, so on a fresh
  // machine the ref is a dangling pointer. It must read as "no key" — never a
  // throw, never a phantom "key saved" badge.
  it('treats an orphan ref from another machine as no key', async () => {
    const home = fakeHomeSeeded({ providers: { tavily: { secretRef: 'orphan-ref-from-another-machine' } } });
    const s = new SearchKeyStore(home, fakeSecrets() as any); // EMPTY secrets — ref points at nothing
    expect((await s.list()).find((p) => p.id === 'tavily')?.hasKey).toBe(false);
    expect(await s.getKey('tavily')).toBeNull();
  });
  // Encrypt-BEFORE-persist ordering, pinned: when SecretsStore.set rejects
  // (e.g. safeStorage unavailable), setKey must propagate the error AND leave
  // the home file untouched — no ref written for a key that was never encrypted.
  // A future reorder that persisted first would fail this test.
  it('does not write the home file when secrets.set throws (encrypt-first)', async () => {
    const home = fakeHome();
    let wrote = false;
    const origMutate = home.mutateJson.bind(home);
    home.mutateJson = async (rel, fn) => { wrote = true; return origMutate(rel, fn); };
    const throwingSecrets = { ...fakeSecrets(), async set() { throw new Error('safeStorage unavailable'); } };
    const s = new SearchKeyStore(home, throwingSecrets as any);
    await expect(s.setKey('tavily', 'tvly-123')).rejects.toThrow(/safeStorage/);
    expect(wrote).toBe(false);            // never reached the persist step
    expect(home.readJson('search-providers.json')).toBeNull(); // no half-state on disk
  });
  it('rejects an empty / whitespace-only key without storing anything', async () => {
    const secrets = fakeSecrets();
    const s = new SearchKeyStore(fakeHome(), secrets as any);
    await expect(s.setKey('tavily', '   ')).rejects.toThrow(/empty/i);
    expect(secrets.m.size).toBe(0);       // nothing encrypted
    expect((await s.list()).find((p) => p.id === 'tavily')?.hasKey).toBe(false);
  });
  it('rejects an unknown backend (untrusted IPC) without persisting junk', async () => {
    const home = fakeHome();
    const secrets = fakeSecrets();
    const s = new SearchKeyStore(home, secrets as any);
    await expect(s.setKey('brave' as any, 'k')).rejects.toThrow(/unknown search provider/i);
    await expect(s.removeKey('brave' as any)).rejects.toThrow(/unknown search provider/i);
    expect(secrets.m.size).toBe(0);                              // nothing encrypted
    expect(home.readJson('search-providers.json')).toBeNull();  // file untouched
  });
});
