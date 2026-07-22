import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceManager, repoNameForSpace, provisionGithubRemote } from '../src/main/sync-spaces/space-manager';
import type { SyncSpace } from '../src/main/sync-spaces/types';

describe('repoNameForSpace', () => {
  it('maps personal and project spaces to stable private repo names', () => {
    expect(repoNameForSpace({ id: 'personal', kind: 'personal', root: '/x' })).toBe('youcoded-sync-personal');
    // Project names carry a short hash of the lowercased id for uniqueness.
    expect(repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' }))
      .toMatch(/^youcoded-sync-project-my-app-[0-9a-f]{8}$/);
  });

  it('is case-insensitive: the same folder name in different case maps to the SAME repo', () => {
    const a = repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' });
    const b = repoNameForSpace({ id: 'project:my app', kind: 'project', root: '/x' });
    expect(a).toBe(b);
  });

  it('distinct folder names that slug identically get DIFFERENT repos', () => {
    const a = repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' });
    const b = repoNameForSpace({ id: 'project:My-App', kind: 'project', root: '/x' });
    expect(a).not.toBe(b);
  });

  it('all-symbol names still produce a valid, unique repo name', () => {
    expect(repoNameForSpace({ id: 'project:###', kind: 'project', root: '/x' }))
      .toMatch(/^youcoded-sync-project-x-[0-9a-f]{8}$/);
  });
});

describe('provisionGithubRemote (injected exec)', () => {
  it('returns the created repo URL with .git suffix', async () => {
    const exec = vi.fn(async () => ({ stdout: 'https://github.com/u/youcoded-sync-personal\n' }));
    await expect(provisionGithubRemote('youcoded-sync-personal', exec))
      .resolves.toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(['repo', 'create', 'youcoded-sync-personal', '--private']);
  });

  it('recovers when create fails but the repo already exists (second device)', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('create failed'), { stderr: 'Name already exists on this account' }))
      .mockResolvedValueOnce({ stdout: 'https://github.com/u/youcoded-sync-personal\n' });
    await expect(provisionGithubRemote('youcoded-sync-personal', exec))
      .resolves.toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][1].slice(0, 3)).toEqual(['repo', 'view', 'youcoded-sync-personal']);
  });

  it('propagates the ORIGINAL create error when view also fails', async () => {
    const original = new Error('network trouble');
    const exec = vi.fn()
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error('view also failed'));
    await expect(provisionGithubRemote('r', exec)).rejects.toBe(original);
  });

  it('throws "unexpected gh output" when create prints garbage and view fails', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: 'something weird\n' })
      .mockRejectedValueOnce(new Error('view failed'));
    await expect(provisionGithubRemote('r', exec)).rejects.toThrow('unexpected gh output');
  });

  it('maps a missing gh binary (ENOENT) to a plain-language error', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const exec = vi.fn().mockRejectedValue(enoent);
    await expect(provisionGithubRemote('r', exec))
      .rejects.toThrow('GitHub CLI (gh) is not installed');
  });

  it('maps a gh auth failure to a plain-language error', async () => {
    const authErr = Object.assign(new Error('exit 4'), { stderr: 'To get started with GitHub CLI, please run: gh auth login' });
    const exec = vi.fn().mockRejectedValue(authErr);
    await expect(provisionGithubRemote('r', exec))
      .rejects.toThrow('Not signed in to GitHub');
  });
});

describe('SpaceManager state', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('persists enabled flag + per-space remotes in sync-spaces.json', () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false);
    m.setEnabled(true);
    expect(new SpaceManager({ stateFile, provisionRemote: vi.fn() }).isEnabled()).toBe(true);
    m.recordRemote('personal', 'https://github.com/u/youcoded-sync-personal.git');
    expect(m.remoteFor('personal')).toBe('https://github.com/u/youcoded-sync-personal.git');
  });

  it('ensureRemote provisions once and caches the URL', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    const provisionRemote = vi.fn(async (name: string) => `https://github.com/u/${name}.git`);
    const m = new SpaceManager({ stateFile, provisionRemote });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    const url1 = await m.ensureRemote(space);
    const url2 = await m.ensureRemote(space);
    expect(url1).toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(url2).toBe(url1);
    expect(provisionRemote).toHaveBeenCalledTimes(1);
  });

  it('a failed provision propagates and does not record a remote', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    // First call fails (e.g. offline / not authed); second succeeds. The failure
    // must NOT poison the state file — remoteFor stays null so a retry can provision.
    const provisionRemote = vi.fn()
      .mockRejectedValueOnce(new Error('gh: not signed in'))
      .mockResolvedValueOnce('https://github.com/u/youcoded-sync-personal.git');
    const m = new SpaceManager({ stateFile, provisionRemote });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await expect(m.ensureRemote(space)).rejects.toThrow('gh: not signed in');
    expect(m.remoteFor('personal')).toBe(null);
    // Retry after the transient failure provisions and records normally.
    await expect(m.ensureRemote(space)).resolves.toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(m.remoteFor('personal')).toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(provisionRemote).toHaveBeenCalledTimes(2);
  });

  it('recordSyncSuccess persists "has ever synced" evidence across instances', () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    // Never-synced default is null — this is what gates the panel's green
    // state: recentEvents is per-boot, so WITHOUT this persisted marker a
    // restart couldn't tell "synced before" from "never synced" (beta.8 VM bug).
    expect(m.lastSyncFor('personal')).toBe(null);
    m.recordSyncSuccess('personal', 1_800_000_000_000);
    expect(m.lastSyncFor('personal')).toBe(1_800_000_000_000);
    // Survives a restart (fresh instance over the same state file) and
    // coexists with the other persisted fields.
    m.setEnabled(true);
    const m2 = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m2.lastSyncFor('personal')).toBe(1_800_000_000_000);
    expect(m2.lastSyncFor('project:other')).toBe(null);
    expect(m2.isEnabled()).toBe(true);
    // A later sync advances the marker.
    m2.recordSyncSuccess('personal', 1_800_000_000_500);
    expect(m2.lastSyncFor('personal')).toBe(1_800_000_000_500);
  });

  it('degrades to defaults when the state file is corrupt, and self-heals on write', () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    fs.writeFileSync(stateFile, '{not json!!');
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false);
    expect(m.remoteFor('personal')).toBe(null);
    m.setEnabled(true);
    expect(new SpaceManager({ stateFile, provisionRemote: vi.fn() }).isEnabled()).toBe(true);
  });
});
