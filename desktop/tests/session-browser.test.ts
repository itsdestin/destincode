import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-browser-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'topics'), { recursive: true });
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
