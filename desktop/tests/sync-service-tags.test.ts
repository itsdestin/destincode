import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub homedir before importing SyncService, because the constructor
// captures paths from os.homedir() at instantiation time.
let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-sync-tags-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'topics'), { recursive: true });
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

async function freshService() {
  // Dynamic import each time so the constructor runs under the stubbed homedir.
  const mod = await import('../src/main/sync-service');
  return new mod.SyncService();
}

function readIndex(): any {
  const p = path.join(tmpHome, '.claude', 'conversation-index.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeTopicFile(sessionId: string, content: string, mtime?: Date): void {
  const p = path.join(tmpHome, '.claude', 'topics', `topic-${sessionId}`);
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime, mtime);
}

describe('setSessionFlag — unknown session with topic file present', () => {
  it('seeds entry from the topic file (topic + mtime), not a bare "Untitled"', async () => {
    const svc = await freshService();
    const mtime = new Date('2026-04-10T12:00:00Z');
    writeTopicFile('sess-a', 'Real topic about cats', mtime);

    svc.setSessionFlag('sess-a', 'complete', true);

    const idx = readIndex();
    expect(idx.sessions['sess-a'].topic).toBe('Real topic about cats');
    expect(new Date(idx.sessions['sess-a'].lastActive).getTime()).toBe(mtime.getTime());
    expect(idx.sessions['sess-a'].slug).not.toBe('');
    expect(idx.sessions['sess-a'].flags.complete.value).toBe(true);
  });
});

describe('setSessionFlag — unknown session with NO topic file', () => {
  it('seeds entry with epoch lastActive as a "pending topic scan" sentinel', async () => {
    const svc = await freshService();

    svc.setSessionFlag('sess-b', 'priority', true);

    const idx = readIndex();
    expect(idx.sessions['sess-b'].flags.priority.value).toBe(true);
    // Epoch (1970-01-01) signals that the next topic scan should overwrite us.
    expect(new Date(idx.sessions['sess-b'].lastActive).getTime()).toBe(0);
  });
});

describe('updateConversationIndex — interaction with epoch-seeded entries', () => {
  it('overwrites an epoch-seeded entry when the topic file shows up', async () => {
    const svc = await freshService();

    // Flag set before topic file existed — entry seeded with epoch lastActive
    svc.setSessionFlag('sess-c', 'helpful', true);
    expect(new Date(readIndex().sessions['sess-c'].lastActive).getTime()).toBe(0);

    // Topic file appears later (user sent first message). The mtime must be
    // RECENT relative to now: updateConversationIndex() prunes any entry whose
    // lastActive is older than INDEX_PRUNE_DAYS (30). A hardcoded past date
    // here is a time bomb — it upserts fine, then gets pruned in the same call
    // once that date ages past the 30-day window. (This test failed exactly
    // that way after 2026-05-12.)
    writeTopicFile('sess-c', 'Topic written later', new Date(Date.now() - 60_000));

    svc.updateConversationIndex();

    const entry = readIndex().sessions['sess-c'];
    expect(entry.topic).toBe('Topic written later');
    // Flag survives the topic-scan overwrite
    expect(entry.flags.helpful.value).toBe(true);
  });

  it('does NOT prune epoch-seeded entries (they are pending, not old)', async () => {
    const svc = await freshService();

    // Epoch-seeded pending entry
    svc.setSessionFlag('sess-d', 'complete', true);

    // Also add a real-old entry that SHOULD be pruned (lastActive 60 days ago)
    const idxPath = path.join(tmpHome, '.claude', 'conversation-index.json');
    const current = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    current.sessions['sess-old'] = {
      topic: 'Old session',
      lastActive: new Date(Date.now() - 60 * 86400_000).toISOString(),
      slug: 'whatever',
      device: 'host',
    };
    fs.writeFileSync(idxPath, JSON.stringify(current));

    svc.updateConversationIndex();

    const after = readIndex();
    // Epoch entry survives prune
    expect(after.sessions['sess-d']).toBeDefined();
    expect(after.sessions['sess-d'].flags.complete.value).toBe(true);
    // Real-old entry is pruned as before
    expect(after.sessions['sess-old']).toBeUndefined();
  });
});

// The 'setSessionFlag — 30s debounced index-only push' and
// 'pullConversationIndexOnly — restore-from-backup hook' describe blocks were
// removed in sync-legacy-demolition: setSessionFlag no longer schedules a backup
// push (scheduleIndexPush/pushIndexOnly deleted), and the pull path
// (pullConversationIndexOnly/fetchIndexFromBackend) is gone. setSessionFlag still
// persists the flag locally — covered by the describe blocks above.
