// desktop/tests/sync-spaces-git-transport.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import type { SyncSpace } from '../src/main/sync-spaces/types';
import { describeTransportContract, TransportHarness } from './sync-transport-contract';

// Real git, local bare repo as the "GitHub" remote. Needs git on PATH (CI has it).
async function makeHarness(): Promise<TransportHarness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-gt-'));
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  let n = 0;
  const transport = new GitTransport({ deviceName: 'TestDevice' });
  return {
    transport,
    async makeDeviceSpace(): Promise<SyncSpace> {
      const root = path.join(tmp, `device-${n++}`);
      fs.mkdirSync(root, { recursive: true });
      const space: SyncSpace = { id: 'project:contract', kind: 'project', root };
      await transport.init(space);
      await transport.setRemote(space, bare);
      return space;
    },
    async cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

describeTransportContract('GitTransport', makeHarness);

describe('GitTransport specifics', () => {
  it('oversize files are excluded from sync and reported', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // 50MB cap — write cap+1 bytes sparsely is slow; instead the transport takes
    // an injectable cap for tests:
    const small = new GitTransport({ deviceName: 'T', maxFileBytes: 10 });
    fs.writeFileSync(path.join(a.root, 'big.bin'), 'x'.repeat(11));
    fs.writeFileSync(path.join(a.root, 'ok.md'), 'fine');
    const r = await small.push(a, 'mixed');
    expect(r.pushed).toBe(true);
    expect(r.oversize).toEqual(['big.bin']);
    await h.cleanup();
  }, 30000);

  it('a tracked file that grows past the cap is excluded ONCE, not re-appended every sync', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const small = new GitTransport({ deviceName: 'T', maxFileBytes: 10 });
    fs.writeFileSync(path.join(a.root, 'log.txt'), 'tiny'); // under cap → gets tracked
    await small.push(a, 'small');
    fs.writeFileSync(path.join(a.root, 'log.txt'), 'x'.repeat(11)); // grows past cap
    const r1 = await small.push(a, 'grew');
    expect(r1.oversize).toEqual(['log.txt']);
    // info/exclude only silences UNTRACKED files, so `git add -A` re-stages the
    // tracked file's growth on EVERY sync — each cycle must not re-append its
    // exclude line (unbounded info/exclude growth at poll cadence).
    const r2 = await small.push(a, 'again');
    expect(r2.oversize).toEqual(['log.txt']);
    const exclude = fs.readFileSync(path.join(a.root, '.youcoded', 'sync.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter(l => l === '/log.txt').length).toBe(1);
    await h.cleanup();
  }, 30000);

  it('a merge that cannot complete surfaces an error instead of silently reporting no update', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const b = await h.makeDeviceSpace();
    const t = h.transport;
    // Divergent same-file edits → the conflict-resolution path runs on pull.
    fs.writeFileSync(path.join(a.root, 'plan.md'), 'base\n');
    await t.push(a, 'base');
    await t.pull(b);
    fs.writeFileSync(path.join(a.root, 'plan.md'), 'A version\n');
    await t.push(a, 'A edit');
    fs.writeFileSync(path.join(b.root, 'plan.md'), 'B version\n');
    // Force the merge-conclusion commit to fail (stands in for lock contention /
    // disk hiccups). Silent {updated:false} here left a non-converging space
    // LOOKING healthy — it must throw so the engine emits an error event.
    const origGit = (t as any).git.bind(t);
    (t as any).git = async (space: SyncSpace, args: string[]) => {
      if (args[0] === 'commit' && args.includes('--no-edit')) return { code: 1, stdout: '', stderr: 'simulated: cannot commit' };
      return origGit(space, args);
    };
    await expect(t.pull(b)).rejects.toThrow(/could not complete/i);
    // The abort left the repo un-wedged: with git healthy again, the next pull
    // converges normally (remote wins canonical + local kept as conflict copy).
    (t as any).git = origGit;
    const retry = await t.pull(b);
    expect(retry.updated).toBe(true);
    expect(retry.conflictCopies.length).toBe(1);
    expect(fs.readFileSync(path.join(b.root, 'plan.md'), 'utf8')).toBe('A version\n');
    await h.cleanup();
  }, 30000);

  it('maybeGc advances the persisted counter and gc actually repacks on the Nth sync', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Force a gc every 2nd call so we don't need 50 iterations.
    const t = new GitTransport({ deviceName: 'T', gcInterval: 2 });
    const gitDir = path.join(a.root, '.youcoded', 'sync.git');
    const counterFile = path.join(a.root, '.youcoded', 'gc-counter');
    const packDir = path.join(gitDir, 'objects', 'pack');
    const gitEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: a.root };
    const git = (...args: string[]) => execFileSync('git', args, { env: gitEnv });
    const packCount = () => { try { return fs.readdirSync(packDir).filter(f => f.endsWith('.pack')).length; } catch { return 0; } };

    // The production command is `git gc --auto`, which decides to run via a
    // heuristic. `--auto`'s LOOSE-object sampler is unreliable on a tiny repo
    // (it samples a single fanout bucket), so instead drive the deterministic
    // TOO-MANY-PACKS trigger: set gc.autoPackLimit=1 and manufacture 2 packs,
    // so `git gc --auto` MUST run and consolidate them back to 1. That proves
    // the gc had a real EFFECT rather than the command silently no-op'ing/failing
    // (both git() and maybeGc swallow failures, so counter-advance alone wouldn't).
    git('config', 'gc.autoPackLimit', '1');
    // gc.autoDetach defaults to TRUE, so `git gc --auto` forks and returns
    // immediately wherever git can daemonize() — i.e. Linux/macOS but NOT
    // Windows. The packCount() assertion below then races the background gc and
    // reads the pre-gc value, which is why this test passed locally on Windows
    // and failed on every ubuntu/macos CI run from 2026-07-14 (ffd17fe5) on.
    // Verified on Linux: with autoDetach default the count is still 2 right
    // after gc and only drops to 1 ~2s later; with it false it's 1 immediately.
    // Pinned here rather than in maybeGc because BACKGROUND gc is the behavior
    // we want in production — a sync must never block on repacking.
    git('config', 'gc.autoDetach', 'false');
    fs.writeFileSync(path.join(a.root, 'f.md'), 'v1');
    await t.push(a, 'c1');
    git('repack', '-d');                       // pack #1 (packs c1's loose objects)
    fs.writeFileSync(path.join(a.root, 'g.md'), 'v2');
    await t.push(a, 'c2');
    git('repack', '-d');                       // pack #2 (packs c2's loose objects)
    expect(packCount()).toBe(2);               // two packs now → over autoPackLimit

    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('1'); // 1 % 2 !== 0, no gc yet
    expect(packCount()).toBe(2);               // untouched — gc did NOT run
    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('2'); // 2 % 2 === 0, gc ran
    expect(packCount()).toBe(1);               // gc consolidated 2 packs → 1: real effect
    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('3');

    // Corrupt counter file → treated as 0, so next write is 1 (never throws).
    fs.writeFileSync(counterFile, 'not-a-number');
    await expect(t.maybeGc(a)).resolves.toBeUndefined();
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('1');
    await h.cleanup();
  }, 30000);

  it('gitDirSizeBytes returns >0 for a real repo and 0 for a missing dir', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T' });
    fs.writeFileSync(path.join(a.root, 'f.md'), 'content');
    await t.push(a, 'commit');
    const size = await t.gitDirSizeBytes(a);
    expect(size).toBeGreaterThan(0);

    // A space whose .youcoded/sync.git doesn't exist reports 0.
    const empty: SyncSpace = { id: 'project:none', kind: 'project', root: path.join(a.root, 'nope') };
    fs.mkdirSync(empty.root, { recursive: true });
    expect(await t.gitDirSizeBytes(empty)).toBe(0);
    await h.cleanup();
  }, 30000);
});
