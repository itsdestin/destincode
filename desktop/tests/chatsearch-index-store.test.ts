import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chatsearchDir, turnsPath, statePath, acquireBuildLock, refreshTurns, readState,
} from '../src/main/chatsearch-index/index-store';
import { decodeTurnLine } from '../src/main/chatsearch-index/index-format';

let tmp: string;
let dir: string;

const ccLine = (text: string, ts = '2026-07-26T18:04:11.000Z') => JSON.stringify({
  type: 'user', promptId: 'p', uuid: `u-${text}`, timestamp: ts,
  message: { role: 'user', content: text },
}) + '\n';

// Transcripts must clear MIN_TRANSCRIPT_BYTES-free scanning; the turns builder
// applies no size floor, so short fixtures are fine.
function writeTranscript(rel: string, body: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

const readTurns = () =>
  fs.readFileSync(turnsPath(dir, 'claude'), 'utf8')
    .split('\n').filter(Boolean).map(decodeTurnLine);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-chatsearch-'));
  dir = chatsearchDir(tmp);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('refreshTurns', () => {
  it('indexes a new transcript from zero', async () => {
    const p = writeTranscript('t/a.jsonl', ccLine('first') + ccLine('second'));
    const stats = await refreshTurns({
      dir, provider: 'claude',
      conversations: [{ id: 'a', transcriptPath: p }],
    });

    const turns = readTurns();
    expect(turns.map((t) => t!.text)).toEqual(['first', 'second']);
    expect(turns.map((t) => t!.turn)).toEqual([1, 2]);
    expect(stats.get('a')).toMatchObject({ turnCount: 2 });
  });

  // The whole point of the state sidecar: a grown transcript is appended from
  // its recorded offset, not re-read whole.
  it('appends only new turns when a transcript grows', async () => {
    const p = writeTranscript('t/a.jsonl', ccLine('first'));
    const conversations = [{ id: 'a', transcriptPath: p }];
    await refreshTurns({ dir, provider: 'claude', conversations });

    fs.appendFileSync(p, ccLine('second'));
    const stats = await refreshTurns({ dir, provider: 'claude', conversations });

    const turns = readTurns();
    expect(turns.map((t) => t!.text)).toEqual(['first', 'second']);
    expect(turns.map((t) => t!.turn)).toEqual([1, 2]);
    expect(stats.get('a')!.turnCount).toBe(2);
  });

  it('is a no-op when nothing changed', async () => {
    const p = writeTranscript('t/a.jsonl', ccLine('only'));
    const conversations = [{ id: 'a', transcriptPath: p }];
    await refreshTurns({ dir, provider: 'claude', conversations });
    const before = fs.readFileSync(turnsPath(dir, 'claude'), 'utf8');

    await refreshTurns({ dir, provider: 'claude', conversations });
    expect(fs.readFileSync(turnsPath(dir, 'claude'), 'utf8')).toBe(before);
  });

  // /clear rewrites and compaction shrink the file. Resuming from the old offset
  // would splice unrelated bytes together, so a shrunk transcript re-reads whole.
  it('re-reads from zero when a transcript shrinks', async () => {
    const p = writeTranscript('t/a.jsonl', ccLine('old-one') + ccLine('old-two'));
    const conversations = [{ id: 'a', transcriptPath: p }];
    await refreshTurns({ dir, provider: 'claude', conversations });

    fs.writeFileSync(p, ccLine('rewritten'));
    await refreshTurns({ dir, provider: 'claude', conversations });

    const turns = readTurns().filter((t) => t!.conversationId === 'a');
    expect(turns.map((t) => t!.text)).toEqual(['rewritten']);
    expect(turns.map((t) => t!.turn)).toEqual([1]);
  });

  // Tombstone rule: the transcript is gone, but its indexed turns are the whole
  // reason the backstop is valuable. Never delete them.
  it('keeps indexed turns when the transcript disappears', async () => {
    const p = writeTranscript('t/a.jsonl', ccLine('remembered'));
    const conversations = [{ id: 'a', transcriptPath: p }];
    await refreshTurns({ dir, provider: 'claude', conversations });

    fs.rmSync(p);
    const stats = await refreshTurns({ dir, provider: 'claude', conversations });

    expect(readTurns().map((t) => t!.text)).toEqual(['remembered']);
    expect(stats.get('a')!.turnCount).toBe(1);
  });

  // The 687-symlink incident, applied to the index: a symlinked transcript is
  // skipped entirely rather than indexed under the wrong conversation.
  it('skips a symlinked transcript', async () => {
    writeTranscript('t/real.jsonl', ccLine('real'));
    const link = path.join(tmp, 't', 'link.jsonl');
    try { fs.symlinkSync('real.jsonl', link, 'file'); } catch { return; } // no symlink support

    await refreshTurns({
      dir, provider: 'claude',
      conversations: [{ id: 'linked', transcriptPath: link }],
    });

    const indexed = fs.existsSync(turnsPath(dir, 'claude'))
      ? readTurns().filter((t) => t!.conversationId === 'linked')
      : [];
    expect(indexed).toEqual([]);
  });

  it('records first/last turn timestamps in the state file', async () => {
    const p = writeTranscript('t/a.jsonl',
      ccLine('one', '2026-07-01T00:00:00.000Z') + ccLine('two', '2026-07-09T00:00:00.000Z'));
    await refreshTurns({ dir, provider: 'claude', conversations: [{ id: 'a', transcriptPath: p }] });

    const st = readState(dir, 'claude');
    expect(st.conversations.a.firstTurnTs).toBe('2026-07-01T00:00:00.000Z');
    expect(st.conversations.a.lastTurnTs).toBe('2026-07-09T00:00:00.000Z');
  });

  it('indexes a native session, skipping its header line', async () => {
    const header = JSON.stringify({ v: 1, sessionId: 'n1', harnessId: 'assistant', cwd: '/x', createdAt: 1 }) + '\n';
    const msg = JSON.stringify({
      type: 'user-message', sessionId: 'n1', uuid: 'u', timestamp: 1785990913428, data: { text: 'native hello' },
    }) + '\n';
    const p = writeTranscript('n/n1.jsonl', header + msg);

    await refreshTurns({
      dir, provider: 'native', lane: 'native',
      conversations: [{ id: 'n1', transcriptPath: p }],
    });

    const lines = fs.readFileSync(turnsPath(dir, 'native'), 'utf8').split('\n').filter(Boolean);
    expect(lines.map((l) => decodeTurnLine(l)!.text)).toEqual(['native hello']);
  });
});

describe('acquireBuildLock', () => {
  // ~/.youcoded/ is shared by the live app and every dev instance. Two builders
  // appending to the same turns file would double-index or corrupt it.
  it('grants the lock once and refuses a second holder', async () => {
    const release = await acquireBuildLock(dir);
    expect(release).not.toBeNull();

    const second = await acquireBuildLock(dir);
    expect(second).toBeNull();

    release!();
    const third = await acquireBuildLock(dir);
    expect(third).not.toBeNull();
    third!();
  });

  it('takes over a stale lock', async () => {
    const lock = path.join(dir, '.build-lock');
    fs.mkdirSync(lock, { recursive: true });
    const old = Date.now() - 10 * 60_000;
    fs.utimesSync(lock, new Date(old), new Date(old));

    const release = await acquireBuildLock(dir);
    expect(release).not.toBeNull();
    release!();
  });
});
