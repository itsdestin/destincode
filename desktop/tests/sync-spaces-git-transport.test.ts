// desktop/tests/sync-spaces-git-transport.test.ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import type { SyncSpace } from '../src/main/sync-spaces/types';
import { describeTransportContract, TransportHarness } from './sync-transport-contract';

// INTEGRATION test, not a unit test: every case spawns real `git` subprocesses,
// so its wall-clock scales with machine load — and vitest's parallel pool
// guarantees load. The 5s default (and even 30s) is a fixed-budget bet that
// loses on a busy machine, which made this file time out nondeterministically
// and block release builds (`npm test` gates the Build step). A generous ceiling
// only bounds the FAILURE case; passing tests return as soon as they finish.
// Applies to the describeTransportContract() cases below too — verified.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
    // Windows holds handles briefly after the git subprocesses exit, so a bare
    // rmSync here threw `EPERM: operation not permitted` under parallel load.
    // Node retries EPERM/EBUSY/ENOTEMPTY natively with linear backoff — same
    // pattern sync-spaces-project-discovery.test.ts already uses.
    async cleanup() { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); },
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
  });

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
  });

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
  });

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
  });

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
  });
});

// Stale git-lock recovery: a git write killed mid-operation (5-min timeout
// SIGTERM, app quit, machine sleep, or a second instance racing the same
// sync.git) leaves an orphaned `*.lock` behind. Git then refuses EVERY
// subsequent write ("Unable to create index.lock: File exists"), wedging the
// space forever until the file is deleted by hand. The transport reaps locks
// older than its stale threshold before each sync so the space self-heals —
// age-gated so we never yank a lock a genuinely-live writer still holds.
describe('GitTransport stale-lock recovery', () => {
  const gitDirOf = (space: SyncSpace) => path.join(space.root, '.youcoded', 'sync.git');
  // Backdate a file's mtime so the age gate treats it as stale. utimes takes seconds.
  const backdate = (file: string, ms: number) => {
    const t = (Date.now() - ms) / 1000;
    fs.utimesSync(file, t, t);
  };

  it('reaps a stale index.lock so a wedged push commits and pushes again', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Tiny stale threshold so the test never waits the real 5-minute default.
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 50 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    // Simulate the crash: an empty, orphaned index.lock aged past the threshold.
    const lock = path.join(gitDirOf(a), 'index.lock');
    fs.writeFileSync(lock, '');
    backdate(lock, 10_000);
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    const r = await t.push(a, 'v2');
    expect(r.pushed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    await h.cleanup();
  });

  it('reaps a stale index.lock so a wedged pull merge no longer throws', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 50 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    const lock = path.join(gitDirOf(a), 'index.lock');
    fs.writeFileSync(lock, '');
    backdate(lock, 10_000);
    // pull() snapshots local changes with a commit — that commit throws the
    // "Sync merge could not complete" error when the lock is present.
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    await expect(t.pull(a)).resolves.toBeDefined();
    expect(fs.existsSync(lock)).toBe(false);
    await h.cleanup();
  });

  it('leaves a FRESH lock untouched (a live writer may still hold it)', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Real 5-minute threshold: a just-created lock is well under it.
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 5 * 60 * 1000 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    const lock = path.join(gitDirOf(a), 'index.lock');
    fs.writeFileSync(lock, ''); // fresh — mtime is now
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    const r = await t.push(a, 'v2');
    // The fresh lock must survive, and because it survived the push could not commit.
    expect(fs.existsSync(lock)).toBe(true);
    expect(r.pushed).toBe(false);
    await h.cleanup();
  });

  it('reaps a stale ref lock under refs/, not just index.lock', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 50 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    // A commit updates refs/heads/main, which needs main.lock — a stale one
    // from a crashed ref update wedges the space just like index.lock.
    const refLock = path.join(gitDirOf(a), 'refs', 'heads', 'main.lock');
    fs.mkdirSync(path.dirname(refLock), { recursive: true });
    fs.writeFileSync(refLock, '');
    backdate(refLock, 10_000);
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    const r = await t.push(a, 'v2');
    expect(r.pushed).toBe(true);
    expect(fs.existsSync(refLock)).toBe(false);
    await h.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (2026-07-22): app-token credentials + auth-failure surfacing.
// The invocation builder and the classifier are PURE — pinned directly. The
// throw-wiring in pull()/push() is pinned by overriding the private git()
// (cast) so no test ever needs a real network/auth failure.
// ---------------------------------------------------------------------------

import {
  credentialedGitInvocation,
  classifyGitAuthFailure,
  GIT_CREDENTIAL_HELPER,
} from '../src/main/sync-spaces/git-transport';

const TOKEN = 'gho_supersecrettoken_should_never_leak';

describe('credentialedGitInvocation', () => {
  it('no token → untouched passthrough (system credential helpers keep working)', () => {
    const args = ['push', '-u', 'origin', 'main'];
    const env = { GIT_DIR: '/x/.youcoded/sync.git' } as NodeJS.ProcessEnv;
    const inv = credentialedGitInvocation(args, env, null);
    expect(inv.args).toBe(args);
    expect(inv.env).toBe(env);
  });

  it('HYGIENE PIN: with a token, the token rides ENV ONLY — never argv', () => {
    const inv = credentialedGitInvocation(['fetch', 'origin', 'main'], {}, TOKEN);
    // Helper list is RESET then replaced, so our token takes precedence over
    // any stale system helper.
    expect(inv.args.slice(0, 4)).toEqual([
      '-c', 'credential.helper=',
      '-c', `credential.helper=${GIT_CREDENTIAL_HELPER}`,
    ]);
    expect(inv.args.join(' ')).not.toContain(TOKEN);
    expect(inv.env.YOUCODED_GIT_TOKEN).toBe(TOKEN);
    // Never hang on a TTY prompt we cannot answer.
    expect(inv.env.GIT_TERMINAL_PROMPT).toBe('0');
    // The helper reads the env var by NAME — it must appear in the helper
    // string or the credentials would silently be empty.
    expect(GIT_CREDENTIAL_HELPER).toContain('$YOUCODED_GIT_TOKEN');
  });
});

describe('classifyGitAuthFailure', () => {
  it('recognizes auth stderr shapes and picks the accurate message by token use', () => {
    for (const stderr of [
      "fatal: Authentication failed for 'https://github.com/u/r.git/'",
      'remote: Invalid credentials',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'fatal: unable to access …: The requested URL returned error: 403',
    ]) {
      expect(classifyGitAuthFailure(stderr, true)?.message).toContain('GitHub sign-in expired');
      expect(classifyGitAuthFailure(stderr, false)?.message).toContain('Not connected to GitHub');
      expect(classifyGitAuthFailure(stderr, true)?.code).toBe('github-auth');
    }
  });

  it('returns null for every non-auth failure (offline stays silent by contract)', () => {
    for (const stderr of [
      'fatal: unable to access …: Could not resolve host: github.com',
      'fatal: the remote end hung up unexpectedly',
      '',
    ]) {
      expect(classifyGitAuthFailure(stderr, true)).toBeNull();
    }
  });
});

describe('GitTransport auth-failure surfacing', () => {
  const space: SyncSpace = { id: 'personal', kind: 'personal', root: '/nowhere' };
  const AUTH_STDERR = "fatal: Authentication failed for 'https://github.com/u/r.git/'";

  /** Transport whose git() is scripted per leading arg — no real git runs. */
  function scripted(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    const t = new GitTransport({ deviceName: 'test', getAuthToken: async () => TOKEN });
    (t as any).git = vi.fn(async (_s: SyncSpace, args: string[]) => {
      const r = responses[args[0]] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', tokenUsed: true };
    });
    (t as any).reapStaleLocks = () => {};
    return t;
  }

  it('pull(): an auth-refused fetch THROWS the coded plain-language error (never mistaken for offline)', async () => {
    const t = scripted({
      remote: { code: 0, stdout: 'https://github.com/u/r.git' }, // hasRemote → true
      diff: { code: 0, stdout: '' },                             // nothing staged
      fetch: { code: 1, stderr: AUTH_STDERR },
    });
    const err = await t.pull(space).catch((e) => e);
    expect(String(err.message)).toContain('GitHub sign-in expired');
    expect(err.syncErrorCode).toBe('github-auth');
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it('pull(): a NON-auth fetch failure keeps the silent offline contract (spec §13)', async () => {
    const t = scripted({
      remote: { code: 0, stdout: 'https://github.com/u/r.git' },
      diff: { code: 0, stdout: '' },
      fetch: { code: 1, stderr: 'fatal: Could not resolve host: github.com' },
    });
    await expect(t.pull(space)).resolves.toEqual({ updated: false, conflictCopies: [] });
  });

  it('push(): an auth-refused push (after the recovery retry) THROWS the coded error', async () => {
    const t = scripted({
      remote: { code: 0, stdout: 'https://github.com/u/r.git' },
      add: { code: 0 },
      diff: { code: 0, stdout: '' },
      'rev-list': { code: 0, stdout: '1' },
      // fetch succeeds (token can read but not write — e.g. lost repo access),
      // so pull() completes and only the push retry hits the refusal.
      fetch: { code: 1, stderr: 'fatal: Could not resolve host: github.com' },
      push: { code: 1, stderr: AUTH_STDERR },
    });
    const err = await t.push(space, 'msg').catch((e) => e);
    expect(String(err.message)).toContain('GitHub sign-in expired');
    expect(err.syncErrorCode).toBe('github-auth');
    expect(String(err.message)).not.toContain(TOKEN);
  });
});
