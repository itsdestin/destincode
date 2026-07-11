// Tests for NativeHome — the single module all ~/.youcoded/ I/O goes through.
// Real filesystem (temp dir per test), no fs mocking — the locking + atomic-write
// behavior is exactly what we need to exercise for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';

describe('NativeHome', () => {
  let root: string;
  let home: NativeHome;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-native-home-'));
    home = new NativeHome(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('does not create the directory until first write (lazy)', () => {
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    expect(home.readJson('providers.json')).toBeNull();          // read of nothing is null, still no dir
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
  });

  it('writeJson round-trips and creates the dir', async () => {
    await home.writeJson('providers.json', { v: 1, providers: [] });
    expect(home.readJson('providers.json')).toEqual({ v: 1, providers: [] });
    expect(fs.existsSync(path.join(root, '.youcoded', 'providers.json'))).toBe(true);
  });

  it('mutateJson applies read-modify-write under the lock', async () => {
    await home.writeJson('providers.json', { v: 1, providers: [] });
    await home.mutateJson('providers.json', (cur: any) => ({ ...cur, providers: [{ id: 'x' }] }));
    expect((home.readJson('providers.json') as any).providers).toHaveLength(1);
  });

  it('appendSessionLine + readSessionLines round-trip under sessions/<slug>/<id>.jsonl', async () => {
    await home.appendSessionLine('my-slug', 'abc', { v: 1, sessionId: 'abc' });
    await home.appendSessionLine('my-slug', 'abc', { type: 'user-message' });
    const lines = home.readSessionLines('my-slug', 'abc');
    expect(lines).toEqual([{ v: 1, sessionId: 'abc' }, { type: 'user-message' }]);
    expect(home.readSessionLines('my-slug', 'missing')).toEqual([]);
  });

  // Contention: cas-write's lock is a <target>.lock DIRECTORY. Pre-creating it
  // with a fresh mtime means acquireLock can't stale-break it (30s heuristic),
  // so every attempt times out after LOCK_MAX_WAIT_MS (3s). maxRetries: 1 keeps
  // the test at ~3s while exercising the exact same contention + throw path the
  // default 5-retry production config uses. Real fs, no mocking of cas-write.
  it('mutateJson throws when the lock cannot be acquired', async () => {
    await home.writeJson('providers.json', { v: 1 });
    const lock = path.join(root, '.youcoded', 'providers.json.lock');
    fs.mkdirSync(lock, { recursive: true }); // fresh lock dir — held by "another process"
    try {
      await expect(
        home.mutateJson('providers.json', (cur) => cur, { maxRetries: 1 })
      ).rejects.toThrow(/lock/i);
      // The contended write must NOT have touched the file.
      expect(home.readJson('providers.json')).toEqual({ v: 1 });
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }, 10_000); // one lock-wait cycle is ~3s; vitest default 5s is too tight for slow CI

  it('listSessionFiles enumerates slug dirs with mtimes', async () => {
    await home.appendSessionLine('slug-a', 's1', { v: 1 });
    const files = home.listSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ slug: 'slug-a', sessionId: 's1' });
    expect(typeof files[0].mtimeMs).toBe('number');
    expect(typeof files[0].sizeBytes).toBe('number');
  });
});
