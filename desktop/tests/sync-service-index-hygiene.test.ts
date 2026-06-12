import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-idx-hygiene-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'topics'), { recursive: true });
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

async function freshService() {
  vi.resetModules();
  const mod = await import('../src/main/sync-service');
  return new mod.SyncService();
}

const indexPath = () => path.join(tmpHome, '.claude', 'conversation-index.json');
const readIndex = () => JSON.parse(fs.readFileSync(indexPath(), 'utf8'));

const GOOD_ID = '3f3a5ccc-98cc-4698-a9a5-2a3c643f03c5';
const PHANTOM_ID = '3f3a5cccc-98cc-4698-a9a5-2a3c643f03c5'; // nine c's — real corruption seen 2026-06-12

function writeTopic(id: string, topic: string) {
  fs.writeFileSync(path.join(tmpHome, '.claude', 'topics', `topic-${id}`), topic);
}

describe('updateConversationIndex — phantom id guard', () => {
  it('skips topic files whose session id is not a canonical UUID', async () => {
    const svc = await freshService();
    writeTopic(GOOD_ID, 'Real Session');
    writeTopic(PHANTOM_ID, 'Phantom Session');
    svc.updateConversationIndex();
    const idx = readIndex();
    expect(idx.sessions[GOOD_ID]).toBeTruthy();
    expect(idx.sessions[PHANTOM_ID]).toBeUndefined();
  });

  it('self-heals: deletes existing malformed entries with no flags, keeps flagged ones', async () => {
    fs.writeFileSync(indexPath(), JSON.stringify({
      version: 1,
      sessions: {
        [PHANTOM_ID]: { topic: 'Phantom', lastActive: new Date().toISOString(), slug: '', device: 'x' },
        'sess-with-flag': {
          topic: 'Untitled', lastActive: new Date(0).toISOString(), slug: '', device: 'x',
          flags: { complete: { value: true, updatedAt: new Date().toISOString() } },
        },
        [GOOD_ID]: { topic: 'Real', lastActive: new Date().toISOString(), slug: '', device: 'x' },
      },
    }));
    const svc = await freshService();
    svc.updateConversationIndex();
    const idx = readIndex();
    expect(idx.sessions[PHANTOM_ID]).toBeUndefined();
    expect(idx.sessions['sess-with-flag']).toBeTruthy(); // flagged → kept
    expect(idx.sessions[GOOD_ID]).toBeTruthy();
  });

  // Composition of the scan guard + self-heal: an EXISTING flagless phantom
  // entry whose phantom topic file is still on disk gets updated by the scan
  // (the guard only blocks creation) and then deleted by the prune — net
  // removal. Pins the seam so a future "optimization" of the scan guard
  // can't silently change update-then-delete into something else.
  it('net-deletes a flagless phantom entry even when its topic file still exists', async () => {
    fs.writeFileSync(indexPath(), JSON.stringify({
      version: 1,
      sessions: {
        [PHANTOM_ID]: { topic: 'Old Phantom', lastActive: new Date().toISOString(), slug: '', device: 'x' },
      },
    }));
    writeTopic(PHANTOM_ID, 'Phantom Reborn');
    const svc = await freshService();
    svc.updateConversationIndex();
    const idx = readIndex();
    expect(idx.sessions[PHANTOM_ID]).toBeUndefined();
  });
});

describe('regenerateTopicCache — mtime preservation', () => {
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago

  it('stamps regenerated topic files with the entry lastActive, not now', async () => {
    fs.writeFileSync(indexPath(), JSON.stringify({
      version: 1,
      sessions: {
        [GOOD_ID]: { topic: 'Real Session', lastActive: RECENT.toISOString(), slug: '', device: 'x' },
      },
    }));
    const svc = await freshService();
    svc.regenerateTopicCache();
    const f = path.join(tmpHome, '.claude', 'topics', `topic-${GOOD_ID}`);
    expect(fs.existsSync(f)).toBe(true);
    expect(Math.abs(fs.statSync(f).mtimeMs - RECENT.getTime())).toBeLessThan(2000);
  });

  it('does not bump lastActive when updateConversationIndex runs after a regenerate', async () => {
    fs.writeFileSync(indexPath(), JSON.stringify({
      version: 1,
      sessions: {
        [GOOD_ID]: { topic: 'Real Session', lastActive: RECENT.toISOString(), slug: '', device: 'x' },
      },
    }));
    const svc = await freshService();
    svc.regenerateTopicCache();
    svc.updateConversationIndex();
    const idx = readIndex();
    expect(Math.abs(new Date(idx.sessions[GOOD_ID].lastActive).getTime() - RECENT.getTime())).toBeLessThan(2000);
  });

  it('skips placeholder topics entirely', async () => {
    fs.writeFileSync(indexPath(), JSON.stringify({
      version: 1,
      sessions: {
        [GOOD_ID]: { topic: 'Untitled', lastActive: RECENT.toISOString(), slug: '', device: 'x' },
      },
    }));
    const svc = await freshService();
    svc.regenerateTopicCache();
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'topics', `topic-${GOOD_ID}`))).toBe(false);
  });

  it('skips entries older than the index prune window', async () => {
    const OLD = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45 days ago
    fs.writeFileSync(indexPath(), JSON.stringify({
      version: 1,
      sessions: {
        [GOOD_ID]: { topic: 'Ancient Session', lastActive: OLD.toISOString(), slug: '', device: 'x' },
      },
    }));
    const svc = await freshService();
    svc.regenerateTopicCache();
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'topics', `topic-${GOOD_ID}`))).toBe(false);
  });
});
