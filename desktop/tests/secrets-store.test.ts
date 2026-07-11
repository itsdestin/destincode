// SecretsStore — safeStorage-encrypted API keys in userData. The critical
// pin here is the "NEVER writes the plaintext key to disk" test: the whole
// design (spec §2.1) is that providers.json only holds secretRef pointers and
// the key itself only ever exists on disk as OS-keychain-bound ciphertext.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SecretsStore } from '../src/main/providers/secrets-store';

describe('SecretsStore', () => {
  let dir: string;
  let store: SecretsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-secrets-'));
    store = new SecretsStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
});
