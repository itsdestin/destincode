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
import type { PullResult, PushResult, SpaceVersion, SyncSpace, SyncTransport } from './types';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 5 * 60 * 1000; // mirrors sync-service.ts GIT_TIMEOUT

interface ExecResult { code: number; stdout: string; stderr: string; }

export class GitTransport implements SyncTransport {
  private deviceName: string;
  private maxFileBytes: number;

  constructor(opts: { deviceName: string; maxFileBytes?: number }) {
    this.deviceName = opts.deviceName;
    this.maxFileBytes = opts.maxFileBytes ?? MAX_SYNC_FILE_BYTES;
  }

  private gitDir(space: SyncSpace): string {
    return path.join(space.root, '.youcoded', 'sync.git');
  }

  private async git(space: SyncSpace, args: string[]): Promise<ExecResult> {
    const env = { ...process.env, GIT_DIR: this.gitDir(space), GIT_WORK_TREE: space.root };
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd: space.root, env, timeout: GIT_TIMEOUT });
      return { code: 0, stdout, stderr };
    } catch (e: any) {
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e) };
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
      await this.pull(space);
      const retry = await this.git(space, ['push', '-u', 'origin', 'main']);
      return { pushed: retry.code === 0, commit, oversize };
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
      // Persist the exclusion so the watcher doesn't re-stage it every cycle.
      fs.appendFileSync(path.join(this.gitDir(space), 'info', 'exclude'),
        oversize.map(o => `/${o}`).join('\n') + '\n');
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
      // Stage 2 = ours (this device), stage 3 = theirs (remote).
      const ours = await this.git(space, ['show', `:2:${rel}`]);
      const theirs = await this.git(space, ['show', `:3:${rel}`]);
      if (ours.code === 0) {
        const copyRel = this.freeCopyName(space, rel);
        fs.mkdirSync(path.dirname(path.join(space.root, copyRel)), { recursive: true });
        fs.writeFileSync(path.join(space.root, copyRel), ours.stdout);
        await this.git(space, ['add', copyRel]);
        copies.push(copyRel);
      }
      if (theirs.code === 0) {
        await this.git(space, ['checkout', '--theirs', '--', rel]);
        await this.git(space, ['add', rel]);
      } else {
        await this.git(space, ['rm', '--force', '--', rel]); // deleted remotely → deletion wins canonical
      }
    }
    const commit = await this.git(space, ['commit', '--no-edit']);
    if (commit.code !== 0) {
      // Merge could not complete — bail out rather than leave a wedged repo.
      await this.git(space, ['merge', '--abort']);
      return { updated: false, conflictCopies: [] };
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
}
