// desktop/tests/sync-spaces-repair.test.ts
// Real-git INTEGRATION tests for the two-tier corruption repair (2026-07-30
// spec §2), plus unit tests for the pure fs helpers. Same conventions as
// sync-spaces-git-transport.test.ts (real subprocesses → generous ceiling).
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import { deleteZeroByteObjects, brokenBackupName, pruneBrokenBackups } from '../src/main/sync-spaces/repair';
import type { SyncSpace } from '../src/main/sync-spaces/types';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Fix (test fidelity): git writes loose objects READ-ONLY (mode 0444), so a
// bare fs.truncateSync on one fails EACCES before it can corrupt anything —
// the test would then be silently testing nothing. chmod to writable first,
// exactly like Task 3's helper had to.
function truncateObject(p: string): void {
  fs.chmodSync(p, 0o644);
  fs.truncateSync(p, 0);
}

function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-repair-'));
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  const root = path.join(tmp, 'device');
  fs.mkdirSync(root);
  const space: SyncSpace = { id: 'project:repair', kind: 'project', root };
  const transport = new GitTransport({ deviceName: 'RepairTest' });
  const gitDir = path.join(root, '.youcoded', 'sync.git');
  const gitEnv = { ...process.env, GIT_DIR: gitDir };
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { tmp, bare, root, space, transport, gitDir, gitEnv, cleanup };
}

/** Clone the bare remote and return the file list + a file's content. */
function remoteState(bare: string, tmp: string): { files: string[]; read: (f: string) => string } {
  const co = fs.mkdtempSync(path.join(tmp, 'verify-'));
  execFileSync('git', ['clone', '--quiet', bare, co]);
  const files = fs.readdirSync(co).filter(f => f !== '.git').sort();
  return { files, read: (f) => fs.readFileSync(path.join(co, f), 'utf8') };
}

describe('repair helpers (pure)', () => {
  it('deleteZeroByteObjects removes exactly the empty poison files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-zb-'));
    const objects = path.join(tmp, 'objects');
    fs.mkdirSync(path.join(objects, 'ab'), { recursive: true });
    fs.mkdirSync(path.join(objects, 'cd'), { recursive: true });
    fs.writeFileSync(path.join(objects, 'ab', 'empty1'), '');
    fs.writeFileSync(path.join(objects, 'cd', 'empty2'), '');
    fs.writeFileSync(path.join(objects, 'cd', 'real'), 'content');
    expect(deleteZeroByteObjects(tmp)).toBe(2);
    expect(fs.existsSync(path.join(objects, 'cd', 'real'))).toBe(true);
    expect(fs.existsSync(path.join(objects, 'ab', 'empty1'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('pruneBrokenBackups keeps only the newest backup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-pb-'));
    const gd = path.join(tmp, 'sync.git');
    fs.mkdirSync(`${gd}.broken-2026-07-27T19-21-00`);
    fs.mkdirSync(`${gd}.broken-2026-07-28T20-16-00`);
    fs.mkdirSync(`${gd}.broken-2026-07-30T14-00-00`);
    pruneBrokenBackups(gd);
    expect(fs.readdirSync(tmp).sort()).toEqual(['sync.git.broken-2026-07-30T14-00-00']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('brokenBackupName is filesystem-safe (no colons — Windows)', () => {
    const name = brokenBackupName('/x/sync.git', new Date('2026-07-30T14:05:06Z'));
    expect(name).toBe('/x/sync.git.broken-2026-07-30T14-05-06');
  });
});

describe('GitTransport.repair (real git)', () => {
  it('Tier 1: zero-byte HEAD object → reset to origin/main → next push recovers ALL local content', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'pushed.md'), 'made it out');
    await w.transport.push(w.space, 'seed');                       // origin/main exists
    // Local-only commit after the push, then the crash zeroes its object —
    // mirrors the Z13: local tip unreadable, older origin/main intact, and the
    // stranded commit NEVER reached the remote (rewind the bare too).
    fs.writeFileSync(path.join(w.root, 'stranded.md'), 'local only');
    await w.transport.push(w.space, 'will be stranded');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { env: w.gitEnv }).toString().trim();
    const prev = execFileSync('git', ['rev-parse', 'HEAD~1'], { env: w.gitEnv }).toString().trim(); // resolve BEFORE truncating
    truncateObject(path.join(w.gitDir, 'objects', head.slice(0, 2), head.slice(2)));
    execFileSync('git', ['--git-dir', w.bare, 'update-ref', 'refs/heads/main', prev]);       // remote never saw the crash commit
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', prev], { env: w.gitEnv }); // local mirror agrees

    await expect(w.transport.push(w.space, 'x')).rejects.toMatchObject({ syncErrorCode: 'repo-corrupt' });
    await w.transport.repair!(w.space);
    expect(fs.existsSync(w.gitDir)).toBe(true);                    // Tier 1 — repo NOT moved aside
    fs.writeFileSync(path.join(w.root, 'after-heal.md'), 'post');
    const r = await w.transport.push(w.space, 'healed snapshot');
    expect(r.pushed).toBe(true);
    const remote = remoteState(w.bare, w.tmp);
    // Every worktree file made it out — including the one stranded by the crash.
    expect(remote.files).toEqual(['after-heal.md', 'pushed.md', 'stranded.md']);
    expect(remote.read('stranded.md')).toBe('local only');
    w.cleanup();
  });

  it('Tier 2: origin/main unreadable too → repo moved aside as .broken-*, fresh init', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'a.md'), 'content-a');
    await w.transport.push(w.space, 'seed');
    // Zero EVERY loose object: local origin/main's closure is gone → Tier 1
    // verification fails → Tier 2.
    const objects = path.join(w.gitDir, 'objects');
    for (const d of fs.readdirSync(objects)) {
      const dir = path.join(objects, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) truncateObject(path.join(dir, f));
    }
    await w.transport.repair!(w.space);
    const parent = path.join(w.root, '.youcoded');
    const entries = fs.readdirSync(parent);
    expect(entries.some(e => e.startsWith('sync.git.broken-'))).toBe(true);  // backup kept
    expect(fs.existsSync(path.join(w.gitDir, 'HEAD'))).toBe(true);           // fresh repo
    // Re-provision (the engine's ensureProvisioned does this in prod), then a
    // normal pull+push cycle converges: remote history re-adopted, worktree pushed.
    await w.transport.setRemote(w.space, w.bare);
    await w.transport.pull(w.space);
    fs.writeFileSync(path.join(w.root, 'b.md'), 'content-b');
    const r = await w.transport.push(w.space, 'post tier2');
    expect(r.pushed).toBe(true);
    const remote = remoteState(w.bare, w.tmp);
    expect(remote.files).toEqual(['a.md', 'b.md']);
    w.cleanup();
  });

  it('worktree files are NEVER touched by repair', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'precious.md'), 'do not touch');
    await w.transport.push(w.space, 'seed');
    const before = fs.statSync(path.join(w.root, 'precious.md')).mtimeMs;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { env: w.gitEnv }).toString().trim();
    truncateObject(path.join(w.gitDir, 'objects', head.slice(0, 2), head.slice(2)));
    await w.transport.repair!(w.space);
    expect(fs.readFileSync(path.join(w.root, 'precious.md'), 'utf8')).toBe('do not touch');
    expect(fs.statSync(path.join(w.root, 'precious.md')).mtimeMs).toBe(before);
    w.cleanup();
  });
});
