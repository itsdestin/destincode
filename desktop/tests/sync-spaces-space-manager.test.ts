import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceManager, repoNameForSpace } from '../src/main/sync-spaces/space-manager';
import type { SyncSpace } from '../src/main/sync-spaces/types';

describe('repoNameForSpace', () => {
  it('maps personal and project spaces to stable private repo names', () => {
    expect(repoNameForSpace({ id: 'personal', kind: 'personal', root: '/x' })).toBe('youcoded-sync-personal');
    expect(repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' })).toBe('youcoded-sync-project-my-app');
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
});
