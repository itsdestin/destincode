import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutDetail as rawDetail, backupWork as rawBackup } from '../dev-dashboard/detail.mjs';
import type { CheckoutDetailData, BackupResult } from '../src/renderer/dev/dashboard/api';

// The helper is plain ESM with no .d.ts. Naming its real shape here is what makes
// the tests type-check, and keeps this file honest about the contract the UI
// consumes — if the two drift, tsconfig.tests.json says so.
const checkoutDetail = rawDetail as (c: unknown, o?: { includePr?: boolean }) => Promise<CheckoutDetailData>;
const backupWork = rawBackup as (c: unknown) => Promise<BackupResult>;

const g = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();

describe('checkoutDetail and backupWork', () => {
  let root: string;
  let repo: string;
  let wt: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-detail-'));
    const origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'pipe' });
    execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
    g(repo, 'config', 'user.email', 't@t.t');
    g(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-m', 'base');
    g(repo, 'push', 'origin', 'master');

    wt = path.join(root, 'wt');
    g(repo, 'worktree', 'add', '-b', 'feat/thing', wt, 'master');
    g(wt, 'config', 'user.email', 't@t.t');
    g(wt, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(wt, 'notes.md'), '# notes\nsome writing\n');
    fs.writeFileSync(path.join(wt, 'code.ts'), 'export const x = 1;\n');
    fs.appendFileSync(path.join(wt, 'a.txt'), 'edited\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const checkout = () => ({ id: 'x', path: wt, name: 'wt', branch: 'feat/thing' });

  it('groups files by what they ARE, not by extension', async () => {
    // "14 files changed" says nothing to someone who does not read code.
    // "notes and documents" vs "code" says whether the work is worth keeping.
    const d = await checkoutDetail(checkout(), { includePr: false });
    expect(Object.keys(d.byKind).sort()).toEqual(['Code', 'Notes and documents']);
    expect(d.byKind['Notes and documents'].map((f) => f.file)).toContain('notes.md');
  });

  it('says whether each file is new or edited, in words', async () => {
    const d = await checkoutDetail(checkout(), { includePr: false });
    const byName = Object.fromEntries(d.files.map((f) => [f.file, f.state]));
    expect(byName['notes.md']).toBe('new, never saved');
    expect(byName['a.txt']).toBe('edited');
  });

  it('does not lose the first character of the first edited filename', () => {
    // git status --porcelain writes " M path" for an unstaged edit. Trimming the
    // whole output eats that leading space on the FIRST line only, so one
    // filename silently lost a character — shown confidently, and intermittent
    // because it depends on which file git listed first. Caught by the test
    // above; pinned here as its own named case so a future trim() cannot sneak
    // back in unnoticed.
    const listed = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { stdio: 'pipe' }).toString();
    expect(listed.startsWith(' M ')).toBe(true);
    expect(listed.trim().startsWith('M ')).toBe(true); // the trap, demonstrated
  });

  it('reports no line counts for a brand-new file rather than zero', async () => {
    // Reporting 0 added for an untracked file reads as "empty", which is wrong
    // and would make a real file look like it holds nothing.
    const d = await checkoutDetail(checkout(), { includePr: false });
    const nu = d.files.find((f) => f.file === 'notes.md')!;
    expect(nu.added).toBeNull();
  });

  describe('backupWork', () => {
    it('LEAVES THE WORKING TREE EXACTLY AS IT FOUND IT', async () => {
      // This is the whole safety claim. The obvious implementation — checkout -b,
      // add, commit, checkout back — removes the committed files from the working
      // tree, so a session editing that folder would watch its work vanish. It was
      // written that way first; this test is why it is not shipped that way.
      const before = {
        status: g(wt, 'status', '--porcelain'),
        branch: g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'),
        head: g(wt, 'rev-parse', 'HEAD'),
        notes: fs.readFileSync(path.join(wt, 'notes.md'), 'utf-8'),
      };

      const res = await backupWork(checkout());
      expect(res.ok).toBe(true);

      expect(g(wt, 'status', '--porcelain')).toBe(before.status);
      expect(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(before.branch);
      expect(g(wt, 'rev-parse', 'HEAD')).toBe(before.head);
      expect(fs.readFileSync(path.join(wt, 'notes.md'), 'utf-8')).toBe(before.notes);
      expect(fs.existsSync(path.join(wt, 'notes.md'))).toBe(true);
    });

    it('really does capture the files on the backup branch', async () => {
      // The flip side: leaving the tree alone is worthless if nothing was saved.
      const res = await backupWork(checkout());
      if (!res.ok) throw new Error(`backup failed: ${res.error}`);
      const listed = g(wt, 'ls-tree', '-r', '--name-only', res.branch).split('\n');
      expect(listed).toContain('notes.md');
      expect(listed).toContain('code.ts');
      expect(g(wt, 'show', `${res.branch}:notes.md`)).toContain('some writing');
    });

    it('pushes the backup so it exists somewhere other than this disk', async () => {
      const res = await backupWork(checkout());
      if (!res.ok) throw new Error(`backup failed: ${res.error}`);
      expect(res.pushed).toBe(true);
      const remote = execFileSync('git', ['-C', path.join(root, 'origin.git'), 'branch', '--list'], { stdio: 'pipe' })
        .toString();
      expect(remote).toContain(res.branch.replace('wip/', ''));
    });

    it('does not leave its throwaway index behind', async () => {
      const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('dev-dashboard-index-')).length;
      await backupWork(checkout());
      const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('dev-dashboard-index-')).length;
      expect(after).toBe(before);
    });

    it('never touches the real index, so concurrent staging survives', async () => {
      // A session in that folder may have files staged. The backup must not
      // disturb them — it writes to GIT_INDEX_FILE in the temp dir instead.
      g(wt, 'add', 'code.ts');
      const staged = g(wt, 'diff', '--cached', '--name-only');
      await backupWork(checkout());
      expect(g(wt, 'diff', '--cached', '--name-only')).toBe(staged);
    });

    it('refuses politely when there is nothing to back up', async () => {
      g(wt, 'add', '--all');
      g(wt, 'commit', '-m', 'saved');
      const res = await backupWork(checkout());
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected the backup to refuse');
      expect(res.error).toMatch(/nothing to back up/i);
    });
  });
});
