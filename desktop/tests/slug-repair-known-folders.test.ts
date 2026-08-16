// Pins the fix (found on the first real-data run, 2026-08-15): runSlugRepair's
// default knownFolders assembly must match runReconcile's (conversations/service.ts
// runReconcile) EXACTLY — managed projects FIRST, then saved folders, each source
// individually try-guarded. Before the fix, runSlugRepair only read saved folders
// (~/.claude/youcoded-folders.json), so a MANAGED-only project (never saved) was
// invisible to the repair even though the reconciler buckets by it — the repair
// silently did nothing for that project's mis-filed data. This is a mirror of
// conversations-service.test.ts's "passes managed + saved folder paths as
// knownFolders to the reconciler" test, for the repair side of the same contract.
//
// Isolated in its own file (per the fix plan) because vi.mock on
// sync-spaces/service and saved-folders is module-scoped — slug-repair.test.ts's
// other runSlugRepair tests pass an explicit knownFolders override and must not
// be disturbed by these mocks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { ccProjectSlug } from '../src/main/slug-encoding';
import { createConversationStore } from '../src/main/conversations/conversation-store';

// vi.mock factories are hoisted above imports, so shared fake state is created
// via vi.hoisted for the factories to close over.
const h = vi.hoisted(() => ({
  managedProjects: [] as Array<{ name: string; path: string }>,
  savedFolders: [] as Array<{ path: string }>,
}));

vi.mock('../src/main/sync-spaces/service', () => ({
  getManagedRoots: () => ({ listProjects: () => h.managedProjects, personalRoot: '' }),
}));
vi.mock('../src/main/saved-folders', () => ({
  readFolders: () => h.savedFolders,
}));

import { runSlugRepair, Quarantine } from '../src/main/conversations/slug-repair';

describe('runSlugRepair default knownFolders — managed projects + saved folders (matches runReconcile)', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  const old = new Date(Date.now() - 60 * 60 * 1000); // aged past LIVE_MTIME_MS so 6.1 doesn't defer it
  let home = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'r-known-'));
    h.managedProjects = [];
    h.savedFolders = [];
  });
  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('reaches a MANAGED project that is not in saved folders — moves the mis-filed transcript into it', async () => {
    const P = path.join(home, 'PAF 574 - Something');
    fs.mkdirSync(P, { recursive: true });
    h.managedProjects = [{ name: path.basename(P), path: P }];
    h.savedFolders = []; // NOT saved — the exact gap that hid the project on the real device

    const projectsDir = path.join(home, '.claude', 'projects');
    const homeSlugDir = path.join(projectsDir, ccProjectSlug(home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const wrong = path.join(homeSlugDir, 's1.jsonl');
    fs.writeFileSync(wrong, F('u1', P));
    fs.utimesSync(wrong, old, old);

    const correctDir = path.join(projectsDir, ccProjectSlug(P)); // exists but empty
    fs.mkdirSync(correctDir, { recursive: true });

    const spaceRoot = path.join(home, 'Conversations');
    fs.mkdirSync(path.join(spaceRoot, 'claude', 'transcripts'), { recursive: true });
    const store = createConversationStore(spaceRoot);
    const quarantine = new Quarantine(home);
    const stateFile = path.join(home, '.youcoded', 'state.json');

    // NOTE: no knownFolders override — this is the point of the test. It must
    // come from runSlugRepair's own default assembly reaching the mocked
    // getManagedRoots()/readFolders() the same way runReconcile does.
    await runSlugRepair({ projectsDir, homeDir: home, store, spaceRoot, stateFile, quarantine });

    expect(fs.existsSync(path.join(correctDir, 's1.jsonl'))).toBe(true); // moved to the managed project
    expect(fs.existsSync(wrong)).toBe(false);                            // no longer at the $HOME slug dir
  });

  it('mirror-negative: no managed projects and no saved folders — knownFolders is empty, run is a no-op', async () => {
    h.managedProjects = [];
    h.savedFolders = [];
    const P = path.join(home, 'Some Project');
    fs.mkdirSync(P, { recursive: true });

    const projectsDir = path.join(home, '.claude', 'projects');
    const homeSlugDir = path.join(projectsDir, ccProjectSlug(home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const wrong = path.join(homeSlugDir, 's2.jsonl');
    fs.writeFileSync(wrong, F('u1', P));
    fs.utimesSync(wrong, old, old);

    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    fs.mkdirSync(correctDir, { recursive: true });

    const spaceRoot = path.join(home, 'Conversations');
    fs.mkdirSync(path.join(spaceRoot, 'claude', 'transcripts'), { recursive: true });
    const store = createConversationStore(spaceRoot);
    const quarantine = new Quarantine(home);
    const stateFile = path.join(home, '.youcoded', 'state.json');

    await runSlugRepair({ projectsDir, homeDir: home, store, spaceRoot, stateFile, quarantine });

    expect(fs.existsSync(wrong)).toBe(true);                              // untouched
    expect(fs.existsSync(path.join(correctDir, 's2.jsonl'))).toBe(false); // nothing moved
  });
});
