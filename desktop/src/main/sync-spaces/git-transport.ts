// desktop/src/main/sync-spaces/git-transport.ts
// SyncTransport implementation over a HIDDEN git repo (spec §7).
//
// CRITICAL MECHANISM: we do NOT use `git init --separate-git-dir` — that writes
// a `.git` FILE into the worktree, which would collide with a developer's own
// .git in the same project. Instead every git call runs with GIT_DIR pointing
// at <root>/.youcoded/sync.git and GIT_WORK_TREE at <root>. The user's tree
// never contains any git artifact of ours; their own repo is untouched.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_IGNORES, MAX_SYNC_FILE_BYTES, conflictCopyName } from './guards';
import { nextGcCounter } from './gc-policy';
import type { PullResult, PushResult, SpaceVersion, SyncSpace, SyncTransport } from './types';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 5 * 60 * 1000; // mirrors sync-service.ts GIT_TIMEOUT
const DEFAULT_GC_INTERVAL = 50;    // run a local git gc every 50th successful sync (spec §7)
// Bound the recursive size walk so a pathological repo can never hang the probe.
// Both a total-entry cap AND a depth cap (belt-and-suspenders, matching
// countFilesBounded): fs.Dirent.isSymbolicLink does NOT detect NTFS junctions,
// so a junction cycle wouldn't trip the entry cap on its own (PITFALLS).
const SIZE_WALK_MAX_ENTRIES = 200_000;
const SIZE_WALK_MAX_DEPTH = 100;

interface ExecResult { code: number; stdout: string; stderr: string; }

export class GitTransport implements SyncTransport {
  private deviceName: string;
  private maxFileBytes: number;
  private gcInterval: number;

  constructor(opts: { deviceName: string; maxFileBytes?: number; gcInterval?: number }) {
    this.deviceName = opts.deviceName;
    this.maxFileBytes = opts.maxFileBytes ?? MAX_SYNC_FILE_BYTES;
    // Injectable so tests can force a gc after a couple of syncs instead of 50.
    this.gcInterval = opts.gcInterval ?? DEFAULT_GC_INTERVAL;
  }

  private gitDir(space: SyncSpace): string {
    return path.join(space.root, '.youcoded', 'sync.git');
  }

  private async git(space: SyncSpace, args: string[]): Promise<ExecResult> {
    const env = { ...process.env, GIT_DIR: this.gitDir(space), GIT_WORK_TREE: space.root };
    try {
      // Why maxBuffer 64MB: Node's default is only 1MB and it KILLS the child
      // when output exceeds it — on a big space that silently breaks history()
      // and the name-only file listings this class depends on.
      const { stdout, stderr } = await execFileAsync('git', args,
        { cwd: space.root, env, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (e: any) {
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e) };
    }
  }

  /** Read one side of a conflicted file (stage 2 = ours, 3 = theirs) as raw
   *  BYTES. The string-returning git() helper must never be used for file
   *  CONTENT: utf8 decoding mangles binary files, and a too-small buffer cap
   *  rejects large ones. Returns null when the stage doesn't exist (e.g. the
   *  file is a remote-only add). WHY the maxBuffer must stay ≥ maxFileBytes:
   *  the conflict loop treats null as "no local version to preserve" and lets
   *  checkout --theirs overwrite the file — if this buffer were smaller than
   *  the sync size cap, a big-but-legal local edit would come back null and be
   *  silently DROPPED with no conflict copy. */
  private async showStage(space: SyncSpace, stage: 2 | 3, rel: string): Promise<Buffer | null> {
    const env = { ...process.env, GIT_DIR: this.gitDir(space), GIT_WORK_TREE: space.root };
    try {
      const { stdout } = await execFileAsync('git', ['show', `:${stage}:${rel}`], {
        cwd: space.root, env, timeout: GIT_TIMEOUT,
        encoding: 'buffer', maxBuffer: this.maxFileBytes + 1024 * 1024,
      });
      return stdout as unknown as Buffer;
    } catch {
      return null;
    }
  }

  async init(space: SyncSpace): Promise<void> {
    const gd = this.gitDir(space);
    if (!fs.existsSync(path.join(gd, 'HEAD'))) {
      fs.mkdirSync(gd, { recursive: true });
      await this.git(space, ['init', '--initial-branch=main']);
      await this.git(space, ['config', 'user.name', `YouCoded Sync (${this.deviceName})`]);
      await this.git(space, ['config', 'user.email', 'sync@youcoded.local']);
      // Byte-faithful storage: `* -text` disables ALL end-of-line conversion so
      // bytes round-trip identically on every platform. Fix: the earlier
      // `* text=auto` OVERRODE core.autocrlf=false and re-introduced LF→CRLF on
      // Windows checkout — a sync tool must never rewrite the user's line endings.
      // Set via repo-local info/attributes (never a .gitattributes in the user's tree).
      await this.git(space, ['config', 'core.autocrlf', 'false']);
      fs.writeFileSync(path.join(gd, 'info', 'attributes'), '* -text\n');
    }
    // info/exclude is OURS (rewritten on every init so ignore updates roll out).
    // The user's own .gitignore still applies on top for their repo, not ours.
    fs.writeFileSync(path.join(gd, 'info', 'exclude'), DEFAULT_IGNORES.join('\n') + '\n');
  }

  async hasRemote(space: SyncSpace): Promise<boolean> {
    const r = await this.git(space, ['remote', 'get-url', 'origin']);
    return r.code === 0;
  }

  async setRemote(space: SyncSpace, url: string): Promise<void> {
    const existing = await this.git(space, ['remote', 'get-url', 'origin']);
    if (existing.code === 0) await this.git(space, ['remote', 'set-url', 'origin', url]);
    else await this.git(space, ['remote', 'add', 'origin', url]);
  }

  /** Stage everything, unstage+exclude oversize files, commit, push. */
  async push(space: SyncSpace, message: string): Promise<PushResult> {
    await this.git(space, ['add', '-A']);
    const oversize = await this.unstageOversize(space);
    const staged = await this.git(space, ['diff', '--cached', '--name-only']);
    let commit: string | undefined;
    if (staged.stdout.trim().length > 0) {
      const c = await this.git(space, ['commit', '-m', message]);
      if (c.code !== 0) return { pushed: false, oversize };
      commit = (await this.git(space, ['rev-parse', 'HEAD'])).stdout.trim();
    }
    if (!(await this.hasRemote(space))) return { pushed: false, commit, oversize };
    const ahead = await this.git(space, ['rev-list', '--count', 'origin/main..main']);
    // origin/main may not exist yet (first push) — rev-list fails; push anyway.
    if (ahead.code === 0 && ahead.stdout.trim() === '0' && !commit) return { pushed: false, oversize };
    const p = await this.git(space, ['push', '-u', 'origin', 'main']);
    if (p.code !== 0) {
      // Non-fast-forward: another device pushed first. Merge, then push again.
      // The recovery pull's outcome MUST be surfaced on the result: it applies
      // the peer's changes, and discarding it made those changes invisible to
      // the engine's event (updated:false → no materialize sweep, no discovery,
      // no conflict notice) until some unrelated later pull — a stale-resume /
      // forked-transcript hazard on conversations (2026-07-15 review finding).
      const recovery = await this.pull(space);
      const retry = await this.git(space, ['push', '-u', 'origin', 'main']);
      return { pushed: retry.code === 0, commit, oversize, updated: recovery.updated, conflictCopies: recovery.conflictCopies };
    }
    return { pushed: true, commit, oversize };
  }

  private async unstageOversize(space: SyncSpace): Promise<string[]> {
    const staged = (await this.git(space, ['diff', '--cached', '--name-only', '-z'])).stdout
      .split('\0').filter(Boolean);
    const oversize: string[] = [];
    for (const rel of staged) {
      try {
        if (fs.statSync(path.join(space.root, rel)).size > this.maxFileBytes) oversize.push(rel);
      } catch { /* deleted while staging — fine */ }
    }
    if (oversize.length) {
      await this.git(space, ['reset', '--', ...oversize]);
      // Persist the exclusion so the watcher doesn't re-stage it every cycle —
      // DEDUPED, because exclude only silences UNTRACKED files: a TRACKED file
      // that grew past the cap is re-staged by `git add -A` on every sync, and
      // an unconditional append grew info/exclude without bound at poll cadence.
      const excludePath = path.join(this.gitDir(space), 'info', 'exclude');
      let have = new Set<string>();
      try { have = new Set(fs.readFileSync(excludePath, 'utf8').split('\n')); } catch { /* fresh file */ }
      const fresh = oversize.map(o => `/${o}`).filter(line => !have.has(line));
      if (fresh.length) fs.appendFileSync(excludePath, fresh.join('\n') + '\n');
    }
    return oversize;
  }

  /** Commit local pending, fetch, merge. Convergent conflict rule (spec §8):
   *  REMOTE wins the canonical filename; LOCAL content is preserved as a
   *  visible conflict copy. Both devices converge to identical trees. */
  async pull(space: SyncSpace): Promise<PullResult> {
    // Snapshot local changes first so merge never runs on a dirty tree.
    await this.git(space, ['add', '-A']);
    await this.unstageOversize(space);
    const dirty = (await this.git(space, ['diff', '--cached', '--name-only'])).stdout.trim();
    if (dirty) await this.git(space, ['commit', '-m', `local snapshot before merge (${this.deviceName})`]);

    if (!(await this.hasRemote(space))) return { updated: false, conflictCopies: [] };
    const fetch = await this.git(space, ['fetch', 'origin', 'main']);
    if (fetch.code !== 0) return { updated: false, conflictCopies: [] }; // offline — never block (spec §13)
    // Fix: a fresh device has no local `main` yet (nothing committed). `main..origin/main`
    // errors on an unborn branch, so adopt the remote wholesale on first sync — this is
    // what lets a second device actually receive the first device's push.
    const localMain = await this.git(space, ['rev-parse', '--verify', '--quiet', 'main']);
    if (localMain.code !== 0) {
      const co = await this.git(space, ['checkout', '-B', 'main', 'origin/main']);
      return { updated: co.code === 0, conflictCopies: [] };
    }
    const behind = await this.git(space, ['rev-list', '--count', 'main..origin/main']);
    if (behind.code !== 0 || behind.stdout.trim() === '0') return { updated: false, conflictCopies: [] };

    // Fix: --allow-unrelated-histories covers the mainline "second device" case —
    // a device that enables sync on a space that ALREADY has content (e.g. the
    // Personal space in use on two machines) commits its own unrelated root, and
    // without this flag git refuses the merge ("refusing to merge unrelated
    // histories"), leaving both devices silently stuck forever. Conflicting files
    // still route through the convergent conflict-copy resolution below;
    // non-overlapping files simply union.
    const merge = await this.git(space, ['merge', '--no-edit', '--allow-unrelated-histories', 'origin/main']);
    if (merge.code === 0) return { updated: true, conflictCopies: [] };

    // Conflicts: resolve each convergently.
    const conflicted = (await this.git(space, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
      .split('\0').filter(Boolean);
    const copies: string[] = [];
    for (const rel of conflicted) {
      // Stage 2 = ours (this device), stage 3 = theirs (remote). Content is
      // read as raw bytes via showStage so binary and >1MB files survive the
      // copy intact (utf8 strings would corrupt bytes; Node's 1MB default
      // buffer would reject big files and silently skip the copy).
      const ours = await this.showStage(space, 2, rel);
      if (ours !== null) {
        const copyRel = this.freeCopyName(space, rel);
        fs.mkdirSync(path.dirname(path.join(space.root, copyRel)), { recursive: true });
        fs.writeFileSync(path.join(space.root, copyRel), ours);
        await this.git(space, ['add', copyRel]);
        copies.push(copyRel);
      }
      // Cheap existence probe — the canonical restore stays checkout --theirs
      // (git writes the content itself, so it's already byte-faithful).
      const theirs = await this.git(space, ['cat-file', '-e', `:3:${rel}`]);
      if (theirs.code === 0) {
        await this.git(space, ['checkout', '--theirs', '--', rel]);
        await this.git(space, ['add', rel]);
      } else {
        await this.git(space, ['rm', '--force', '--', rel]); // deleted remotely → deletion wins canonical
      }
    }
    const commit = await this.git(space, ['commit', '--no-edit']);
    if (commit.code !== 0) {
      // Merge could not complete — abort rather than leave a wedged repo, then
      // THROW so the engine emits an error event (red dot + message). The old
      // silent {updated:false} made a persistently unmergeable space look
      // healthy while it quietly stopped converging (2026-07-15 review finding).
      // The abort restores the pre-merge state, so the next sync retries clean.
      await this.git(space, ['merge', '--abort']);
      throw new Error(`Sync merge could not complete for ${space.id}: ${commit.stderr.trim() || 'git commit failed'}`);
    }
    return { updated: true, conflictCopies: copies };
  }

  private freeCopyName(space: SyncSpace, rel: string): string {
    let candidate = conflictCopyName(rel, this.deviceName, new Date());
    let i = 2;
    while (fs.existsSync(path.join(space.root, candidate))) {
      candidate = conflictCopyName(rel, `${this.deviceName} ${i++}`, new Date());
    }
    return candidate;
  }

  async history(space: SyncSpace, limit = 50): Promise<SpaceVersion[]> {
    const r = await this.git(space, ['log', `--max-count=${limit}`, '--format=%H%x1f%cI%x1f%s']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').filter(Boolean).map(line => {
      const [commit, date, message] = line.split('\x1f');
      return { commit, date, message };
    });
  }

  private gcCounterFile(space: SyncSpace): string {
    // Lives NEXT TO sync.git in the hidden dir — NOT in config.json, which is
    // per-user/syncable; a maintenance counter is strictly per-device state.
    return path.join(space.root, '.youcoded', 'gc-counter');
  }

  /** Increment the persisted per-space sync counter and, every Nth sync, run a
   *  LOCAL `git gc --auto --quiet`. The hidden repos grow unbounded from
   *  append-only transcript re-commits with no repack; this reclaims local disk
   *  and keeps push sizes sane. WHY this is safe: `git gc` only repacks THIS
   *  device's objects — it NEVER rewrites history (no force-push, no
   *  filter-branch), so it can never desync a peer. Best-effort throughout: a
   *  gc failure is swallowed (it just retries in another N syncs) and this
   *  method never throws, so maintenance can't break a sync. */
  async maybeGc(space: SyncSpace): Promise<void> {
    const file = this.gcCounterFile(space);
    let prev = 0;
    try { prev = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch { /* missing/corrupt → 0 */ }
    const { counter, shouldGc } = nextGcCounter(prev, this.gcInterval);
    // Persist the incremented counter FIRST, even if gc then fails, so we don't
    // retry gc every single sync after one failure.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(counter));
    } catch { /* can't persist → next sync recomputes from stale/absent file, harmless */ }
    if (!shouldGc) return;
    try {
      // Inherits GIT_DIR/GIT_WORK_TREE via git(); --auto lets git skip if the
      // repo doesn't actually need repacking, --quiet suppresses progress noise.
      await this.git(space, ['gc', '--auto', '--quiet']);
    } catch { /* best-effort; retries in another N syncs */ }
  }

  /** Recursive byte size of <root>/.youcoded/sync.git — feeds the engine's
   *  large-history warning. Bounded (entry cap) and best-effort: returns 0 on
   *  any error or a missing repo, and returns whatever was summed so far if the
   *  walk trips its bound (a partial-but-nonzero size still trips the warning). */
  async gitDirSizeBytes(space: SyncSpace): Promise<number> {
    const root = this.gitDir(space);
    let total = 0;
    let visited = 0;
    const walk = (dir: string, depth: number): void => {
      if (visited >= SIZE_WALK_MAX_ENTRIES || depth > SIZE_WALK_MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (visited >= SIZE_WALK_MAX_ENTRIES) return;
        visited++;
        const full = path.join(dir, e.name);
        // Skip symlinks outright (never follow) — a defense the junction-cycle
        // depth cap backstops on Windows where isSymbolicLink misses junctions.
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* raced away */ } }
      }
    };
    try {
      if (!fs.existsSync(root)) return 0;
      walk(root, 0);
    } catch { return 0; }
    return total;
  }
}
