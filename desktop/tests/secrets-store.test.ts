// SecretsStore — safeStorage-encrypted API keys in userData. The critical
// pin here is the "NEVER writes the plaintext key to disk" test: the whole
// design (spec §2.1) is that providers.json only holds secretRef pointers and
// the key itself only ever exists on disk as OS-keychain-bound ciphertext.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Resolves to tests/__mocks__/electron.ts via the vitest alias — same instance
// the store imports, so spying here affects the store's calls.
import { safeStorage } from 'electron';
import { SecretsStore } from '../src/main/providers/secrets-store';

describe('SecretsStore', () => {
  let dir: string;
  let store: SecretsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-secrets-'));
    store = new SecretsStore(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks(); // undo any isEncryptionAvailable spy
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('set/get round-trips a key', async () => {
    const ref = await store.set('sk-test-12345');
    expect(await store.get(ref)).toBe('sk-test-12345');
  });

  it('NEVER writes the plaintext key to disk', async () => {
    await store.set('sk-super-secret-value');
    const raw = fs.readFileSync(path.join(dir, 'native-secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-super-secret-value');
  });

  it('set with an existing ref replaces in place (same ref back)', async () => {
    const ref = await store.set('sk-old');
    const ref2 = await store.set('sk-new', ref);
    expect(ref2).toBe(ref);
    expect(await store.get(ref)).toBe('sk-new');
  });

  it('delete removes the entry; get of missing ref is null', async () => {
    const ref = await store.set('sk-x');
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });

  it('has() reflects presence and tolerates undefined', () => {
    expect(store.has(undefined)).toBe(false);
    expect(store.has('nonexistent')).toBe(false);
  });

  it('has() is true after set, false after delete', async () => {
    const ref = await store.set('sk-y');
    expect(store.has(ref)).toBe(true);
    await store.delete(ref);
    expect(store.has(ref)).toBe(false);
  });

  it('two secrets coexist under distinct refs', async () => {
    const a = await store.set('sk-a');
    const b = await store.set('sk-b');
    expect(a).not.toBe(b);
    expect(await store.get(a)).toBe('sk-a');
    expect(await store.get(b)).toBe('sk-b');
  });

  it('get returns null for an undecryptable blob (keychain mismatch)', async () => {
    // Simulates a store file copied from another machine: the entry exists
    // but decryptString throws. get() must degrade to null, never throw.
    fs.writeFileSync(
      path.join(dir, 'native-secrets.json'),
      JSON.stringify({ ref1: Buffer.from('garbage', 'utf8').toString('base64') }),
      'utf8'
    );
    expect(await store.get('ref1')).toBeNull();
  });

  it('set throws a user-showable error when the OS keychain is unavailable', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    // Plaintext fallback is refused by design — the throw is the contract.
    await expect(store.set('sk-nope')).rejects.toThrow(/Secure key storage/);
    // Nothing may have been written on the refused path.
    expect(fs.existsSync(path.join(dir, 'native-secrets.json'))).toBe(false);
  });

  // Contention: cas-write's lock is a <target>.lock DIRECTORY. Pre-creating it
  // with a fresh mtime means acquireLock can't stale-break it (30s heuristic),
  // so every attempt times out after LOCK_MAX_WAIT_MS (3s). maxRetries: 1 keeps
  // the test at ~3s while exercising the exact same contention + throw path the
  // default 5-retry production config uses. Real fs, no mocking of cas-write.
  it('set throws when the lock cannot be acquired, without touching the file', async () => {
    const lock = path.join(dir, 'native-secrets.json.lock');
    fs.mkdirSync(lock, { recursive: true }); // fresh lock dir — held by "another process"
    try {
      await expect(store.set('sk-contended', undefined, { maxRetries: 1 })).rejects.toThrow(
        /lock/i
      );
      // The contended write must NOT have created the store file.
      expect(fs.existsSync(path.join(dir, 'native-secrets.json'))).toBe(false);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }, 10_000); // one lock-wait cycle is ~3s; vitest default 5s is too tight for slow CI
});
