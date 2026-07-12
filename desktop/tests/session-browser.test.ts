import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createConversationStore } from '../src/main/conversations/conversation-store';

// Task 7 (store union): session-browser reads the Conversation Store via a
// dynamic import of './conversations/service' inside listPastSessions. The real
// service singleton is only non-null after startConversationStore() runs (which
// drags in the whole sync-spaces graph). We mock the service module to a thin
// facade whose getConversationStore() reads a mutable holder — each store test
// drops a REAL createConversationStore(tempRoot) into the holder, exercising the
// genuine store read path without booting sync-spaces. resetModules re-applies
// vi.mock automatically, so the harness's per-call reset still works.
const storeHolder = vi.hoisted(() => ({ current: null as any }));
// Saved folders the mocked buildLocalProjectResolver resolves against. Empty by
// default → resolution is originalPath-only (the pre-fix behavior most tests
// assume). A cross-OS test drops THIS device's folder in to exercise the
// name/basename fallback that fixes cross-device resume.
const savedHolder = vi.hoisted(() => ({ current: [] as Array<{ path: string }> }));
vi.mock('../src/main/conversations/service', async () => {
  // Reuse the REAL resolver so the mock can't drift from production behavior;
  // managed roots aren't exercised here (empty map), saved folders come from the
  // per-test holder.
  const { resolveLocalProject } = await import('../src/main/conversations/resolve-local-project');
  return {
    getConversationStore: () => storeHolder.current,
    buildLocalProjectResolver: () => (rec: any) => resolveLocalProject(rec, new Map(), savedHolder.current),
  };
});

let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-browser-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'topics'), { recursive: true });
  // Isolation: a prior store test must not leak its store into the next test
  // (existing legacy-only tests assert the store branch is dormant).
  storeHolder.current = null;
  savedHolder.current = [];
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// session-browser captures CLAUDE_DIR from os.homedir() at module load —
// reset + dynamic import per call so the stub applies.
async function listSessions(activeIds?: Set<string>) {
  vi.resetModules();
  const mod = await import('../src/main/session-browser');
  return mod.listPastSessions(activeIds);
}

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

/** A realistic minimal transcript: meta line, user prompt, assistant reply (>500 bytes). */
function writeTranscript(slug: string, sid: string, opts: {
  firstUserText?: string;
  lastTimestamp?: string;
} = {}): string {
  const dir = path.join(tmpHome, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  let content = '';
  content += jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', timestamp: '2026-06-01T10:00:00Z', message: { content: 'meta noise' } });
  content += jsonlLine({
    type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z',
    message: { content: opts.firstUserText ?? 'help me fix the spinner regex in the attention classifier please' },
  });
  content += jsonlLine({
    type: 'assistant', uuid: 'a1', timestamp: opts.lastTimestamp ?? '2026-06-01T10:05:00Z',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done. '.repeat(40) }] },
  });
  fs.writeFileSync(file, content);
  return file;
}

describe('listPastSessions — fallback titles', () => {
  it('derives the name from the first user message when no topic exists', async () => {
    writeTranscript('C--proj-alpha', SID_A);
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('help me fix the spinner regex in the attention…');
  });

  it('prefers the topic file over the derived title', async () => {
    writeTranscript('C--proj-alpha', SID_A);
    fs.writeFileSync(path.join(tmpHome, '.claude', 'topics', `topic-${SID_A}`), 'Spinner Regex Fix');
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('Spinner Regex Fix');
  });

  it('prefers the conversation-index topic over the derived title', async () => {
    writeTranscript('C--proj-alpha', SID_A);
    fs.writeFileSync(path.join(tmpHome, '.claude', 'conversation-index.json'), JSON.stringify({
      version: 1,
      sessions: { [SID_A]: { topic: 'Indexed Name', lastActive: '2026-06-01T10:05:00Z', slug: 'C--proj-alpha', device: 'test' } },
    }));
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('Indexed Name');
  });

  it('skips injected tag-wrapped lines when deriving (e.g. command wrappers)', async () => {
    const dir = path.join(tmpHome, '.claude', 'projects', 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    let content = '';
    content += jsonlLine({
      type: 'user', uuid: 'u0', promptId: 'p0', timestamp: '2026-06-01T09:59:59Z',
      message: { content: '<command-name>/model</command-name>' },
    });
    content += jsonlLine({
      type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z',
      message: { content: 'real question about themes' },
    });
    content += jsonlLine({
      type: 'assistant', uuid: 'a1', timestamp: '2026-06-01T10:05:00Z',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    });
    fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), content);
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('real question about themes');
  });
});

describe('listPastSessions — content-timestamp ordering', () => {
  it('uses the transcript last timestamp instead of a clobbered mtime', async () => {
    const fileA = writeTranscript('C--proj-alpha', SID_A, { lastTimestamp: '2026-06-10T12:00:00Z' });
    const fileB = writeTranscript('C--proj-beta', SID_B, { lastTimestamp: '2026-06-01T12:00:00Z' });
    // Clobber mtimes in the WRONG order (older content gets newer mtime),
    // simulating what a sync restore does.
    fs.utimesSync(fileA, new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(fileB, new Date('2026-06-12'), new Date('2026-06-12'));
    const sessions = await listSessions();
    expect(sessions.map((s: any) => s.sessionId)).toEqual([SID_A, SID_B]);
    expect(sessions[0].lastModified).toBe(Date.parse('2026-06-10T12:00:00Z'));
  });
});

describe('listPastSessions — degradation paths', () => {
  it('handles CRLF transcripts (Windows line endings) for both title and timestamp', async () => {
    const dir = path.join(tmpHome, '.claude', 'projects', 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z', message: { content: 'crlf transcript question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-03T10:05:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'y'.repeat(500) }] } }),
    ];
    fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), lines.join('\r\n') + '\r\n');
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('crlf transcript question');
    expect(sessions[0].lastModified).toBe(Date.parse('2026-06-03T10:05:00Z'));
  });

  it('falls back to Untitled + file mtime when no prompt or timestamp is usable', async () => {
    const dir = path.join(tmpHome, '.claude', 'projects', 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    // No qualifying user line (meta only) and no timestamp on any line.
    const file = path.join(dir, `${SID_A}.jsonl`);
    fs.writeFileSync(file, jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', message: { content: 'z'.repeat(600) } }));
    const mtime = new Date('2026-05-05T00:00:00Z');
    fs.utimesSync(file, mtime, mtime);
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('Untitled');
    expect(sessions[0].lastModified).toBe(mtime.getTime());
  });
});

describe('listPastSessions — existing gates still hold', () => {
  it('skips sub-500-byte files and active sessions, dedups by longest slug', async () => {
    // Empty stub (0 bytes)
    const stubDir = path.join(tmpHome, '.claude', 'projects', 'C--home');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, `${SID_A}.jsonl`), '');
    // Real file for the same id under a longer slug
    writeTranscript('C--home-project-deep', SID_A);
    // Another real file, but active
    writeTranscript('C--proj-beta', SID_B);
    const sessions = await listSessions(new Set([SID_B]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(SID_A);
    expect(sessions[0].projectSlug).toBe('C--home-project-deep');
  });
});

describe('listPastSessions — Conversation Store union (Phase 2a)', () => {
  // Build a real store rooted under the stubbed home and stash it in the holder
  // the mocked service reads. Records live at <root>/claude/<id>.json.
  function seedStore(): ReturnType<typeof createConversationStore> {
    const root = path.join(tmpHome, 'YouCoded', 'Personal', 'Conversations');
    const store = createConversationStore(root);
    storeHolder.current = store;
    return store;
  }

  // A path guaranteed NOT to exist on this device — stands in for the
  // originalPath of a conversation that only ran on another machine.
  const absentProject = () => path.join(tmpHome, 'not-on-this-device', 'remote-proj');

  it('surfaces a remote-device conversation (no local transcript) with resume gated off', async () => {
    const store = seedStore();
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'remote-proj',
      originalPath: absentProject(),
      title: 'Remote Conversation',
      lastActive: '2026-06-20T10:00:00Z',
      device: 'other-laptop',
    });
    await store.setFlag('claude', SID_A, 'priority', true);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    expect(row.sessionId).toBe(SID_A);
    expect(row.name).toBe('Remote Conversation');
    expect(row.lastModified).toBe(Date.parse('2026-06-20T10:00:00Z'));
    expect(row.flags).toEqual({ priority: true });
    expect(row.device).toBe('other-laptop');
    expect(row.provider).toBe('claude');
    expect(row.missingProject).toBe(true);
    // No local project → empty slug (resume has no cwd to resume into here).
    expect(row.projectSlug).toBe('');
  });

  it('collapses a store record + local transcript into ONE row (store metadata wins, local slug kept)', async () => {
    seedStore();
    // Legacy transcript under a real slug, older content timestamp.
    writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'the original local prompt for this session',
      lastTimestamp: '2026-06-01T10:05:00Z',
    });
    const store = storeHolder.current;
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      title: 'Store Title Wins',
      lastActive: '2026-06-25T00:00:00Z',
      device: 'phone',
    });

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1); // ONE row, not two
    const row = sessions[0];
    // Store wins on display metadata...
    expect(row.name).toBe('Store Title Wins');
    expect(row.lastModified).toBe(Date.parse('2026-06-25T00:00:00Z'));
    expect(row.device).toBe('phone');
    expect(row.provider).toBe('claude');
    // ...but the LOCAL transcript keeps the resume slug/path working.
    expect(row.projectSlug).toBe('C--proj-alpha');
    // A both-sources row is resumable here, so it's not flagged missing.
    expect(row.missingProject).toBeUndefined();
  });

  it('leaves a legacy row untouched when the store is off (regression guard)', async () => {
    // storeHolder.current stays null (sync off / store unavailable).
    const file = writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'legacy only conversation with no store record',
      lastTimestamp: '2026-06-08T09:00:00Z',
    });
    const { size } = fs.statSync(file);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    expect(row.sessionId).toBe(SID_A);
    expect(row.name).toBe('legacy only conversation with no store record');
    expect(row.projectSlug).toBe('C--proj-alpha');
    expect(row.lastModified).toBe(Date.parse('2026-06-08T09:00:00Z'));
    expect(row.size).toBe(size);
    // Store-only fields never set on a pure legacy row.
    expect(row.device).toBeUndefined();
    expect(row.provider).toBeUndefined();
    expect(row.missingProject).toBeUndefined();
  });

  it('sorts by lastModified desc across BOTH sources', async () => {
    const store = seedStore();
    // Legacy transcript — OLDER.
    writeTranscript('C--proj-beta', SID_B, { lastTimestamp: '2026-06-01T00:00:00Z' });
    // Store-only remote conversation — NEWER.
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'remote-proj',
      originalPath: absentProject(),
      title: 'Newer Remote',
      lastActive: '2026-06-30T00:00:00Z',
      device: 'other-laptop',
    });

    const sessions = await listSessions();
    expect(sessions.map((s: any) => s.sessionId)).toEqual([SID_A, SID_B]);
  });

  it('never resurfaces a LIVE session from the store (double-attach hazard)', async () => {
    const store = seedStore();
    // A live session gains a store record within seconds of starting (live
    // intake upserts on transcript events). The union must honor the same
    // activeSessionIds exclusion the legacy scan applies — otherwise the
    // running session shows up as a resumable store-only row, and resuming it
    // spawns a second `claude --resume` against the transcript the live
    // session is appending to.
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'proj-alpha',
      originalPath: absentProject(),
      title: 'Currently Running',
      lastActive: '2026-06-28T00:00:00Z',
      device: 'this-machine',
    });
    const sessions = await listSessions(new Set([SID_A]));
    expect(sessions).toHaveLength(0);
  });

  it('gates resume on a store-only row whose folder is local but transcript is not materialized yet', async () => {
    const store = seedStore();
    // Project folder EXISTS on this device, but the transcript hasn't been
    // materialized into ~/.claude/projects yet — `claude --resume` would error.
    const localProj = path.join(tmpHome, 'local-proj');
    fs.mkdirSync(localProj, { recursive: true });
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'local-proj',
      originalPath: localProj,
      title: 'Folder Here, Transcript Pending',
      lastActive: '2026-06-22T00:00:00Z',
      device: 'other-laptop',
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    // Distinct sub-case: the folder is here, sync just hasn't delivered the
    // transcript — renderer shows "Not synced to this device yet".
    expect(row.notSyncedYet).toBe(true);
    expect(row.missingProject).toBeUndefined();
  });

  it('resolves a CROSS-OS store-only record by saved-folder basename (two-device dogfood fix 2026-07-12)', async () => {
    const store = seedStore();
    // THIS device's copy of the project. Its basename ('youcoded-dev') matches
    // the record's projectName; the record's originalPath is the OTHER device's
    // path (a Linux /home/... on the real machine), modeled here as an absolute
    // path that does not exist locally.
    const localProj = path.join(tmpHome, 'youcoded-dev');
    fs.mkdirSync(localProj, { recursive: true });
    savedHolder.current = [{ path: localProj }];
    const foreignOriginalPath = path.join(tmpHome, 'other-device-home', 'youcoded-dev'); // never created
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'youcoded-dev',
      originalPath: foreignOriginalPath,
      title: 'Cross-Device Sync Test',
      lastActive: '2026-07-12T10:43:00Z',
      device: 'destinsZ13',
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    // Before the fix, the foreign originalPath resolved to null → the row was
    // (wrongly) missingProject and, if launched, resume ran in the foreign cwd →
    // blank spawn + exit. Now it resolves to THIS device's folder: an accurate
    // 'not synced yet' row (transcript not materialized in this test) carrying a
    // LOCAL cwd, never the foreign path.
    expect(row.missingProject).toBeUndefined();
    expect(row.notSyncedYet).toBe(true);
    expect(row.projectPath).toBe(localProj);
  });

  it('ignores a literal Untitled store title when the legacy row has a real name', async () => {
    const store = seedStore();
    writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'derived name beats the placeholder',
      lastTimestamp: '2026-06-01T10:05:00Z',
    });
    // Older clients synced literal 'Untitled' topic content; a record seeded
    // fresh through upsert carries it verbatim (only the merge-override path
    // rejects the placeholder, not first-write). The union must not let it
    // clobber a real derived name.
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      title: 'Untitled',
      lastActive: '2026-06-26T00:00:00Z',
      device: 'old-client',
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('derived name beats the placeholder');
  });

  it('degrades to the legacy list when store.list() throws', async () => {
    // A store whose list rejects — the union must swallow it, not fail the call.
    storeHolder.current = { list: () => Promise.reject(new Error('store dir unreadable')) };
    writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'survives a broken store read',
      lastTimestamp: '2026-06-05T00:00:00Z',
    });

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(SID_A);
    expect(sessions[0].name).toBe('survives a broken store read');
  });
});
