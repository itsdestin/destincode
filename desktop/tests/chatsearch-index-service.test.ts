import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onConversationMetaChanged, emitConversationMetaChanged } from '../src/main/conversations/service';
import { refreshChatsearchIndex } from '../src/main/chatsearch-index/index-service';
import { chatsearchDir, metaPath, turnsPath } from '../src/main/chatsearch-index/index-store';
import type { ConversationRecord } from '../src/main/conversations/store-core';

let tmp: string;

const rec = (over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  schema: 1, id: 'c1', provider: 'claude', projectName: 'youcoded',
  originalPath: '/p', title: 'A conversation',
  lastActive: '2026-07-26T18:04:11.000Z', device: 'd', flags: {},
  transcriptRef: 'claude/transcripts/youcoded/c1.jsonl',
  createdAt: '2026-07-26T17:00:00.000Z', note: '', noteUpdatedAt: '',
  ...over,
});

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cs-svc-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('onConversationMetaChanged', () => {
  it('notifies subscribers and unsubscribes cleanly', () => {
    let count = 0;
    const off = onConversationMetaChanged(() => { count++; });
    emitConversationMetaChanged();
    expect(count).toBe(1);
    off();
    emitConversationMetaChanged();
    expect(count).toBe(1);
  });

  it('a throwing listener does not break the emit', () => {
    let reached = false;
    const offBad = onConversationMetaChanged(() => { throw new Error('boom'); });
    const offGood = onConversationMetaChanged(() => { reached = true; });
    expect(() => emitConversationMetaChanged()).not.toThrow();
    expect(reached).toBe(true);
    offBad(); offGood();
  });
});

describe('refreshChatsearchIndex', () => {
  it('writes both index files for a provider', async () => {
    const transcript = path.join(tmp, 'c1.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'user', promptId: 'p', uuid: 'u', timestamp: '2026-07-26T18:04:11.000Z',
      message: { role: 'user', content: 'the indexed message' },
    }) + '\n');

    await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{
        provider: 'claude',
        lane: 'claude',
        records: [rec()],
        resolveTranscriptPath: () => transcript,
      }],
      tagLabels: new Map(),
    });

    const dir = chatsearchDir(tmp);
    const meta = JSON.parse(fs.readFileSync(metaPath(dir, 'claude'), 'utf8'));
    expect(meta.conversations.c1.title).toBe('A conversation');
    expect(meta.conversations.c1.turnCount).toBe(1);
    expect(meta.conversations.c1.tombstone).toBe(false);
    expect(fs.readFileSync(turnsPath(dir, 'claude'), 'utf8')).toContain('the indexed message');
  });

  it('marks a conversation whose transcript never existed as a tombstone', async () => {
    await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{
        provider: 'claude', lane: 'claude', records: [rec()],
        resolveTranscriptPath: () => path.join(tmp, 'missing.jsonl'),
      }],
      tagLabels: new Map(),
    });

    const meta = JSON.parse(fs.readFileSync(metaPath(chatsearchDir(tmp), 'claude'), 'utf8'));
    expect(meta.conversations.c1.tombstone).toBe(true);
  });

  it('skips the cycle when another builder holds the lock', async () => {
    fs.mkdirSync(path.join(chatsearchDir(tmp), '.build-lock'), { recursive: true });

    const ran = await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{ provider: 'claude', lane: 'claude', records: [rec()], resolveTranscriptPath: () => '/nope' }],
      tagLabels: new Map(),
    });

    expect(ran).toBe(false);
    expect(fs.existsSync(metaPath(chatsearchDir(tmp), 'claude'))).toBe(false);
  });

  // Finding 1: store.list() is fail-soft all the way down (conversation-store.ts
  // returns [] on any read failure, no error signal), so an unreadable sync
  // space at refresh time is indistinguishable, at this layer, from "the user
  // really has zero conversations." Writing that zero-conversation result
  // unconditionally would overwrite a good metadata file with an empty one and
  // stamp a fresh refreshedAt, which would suppress the CLI's own staleness
  // banner — the exact "your history doesn't exist" false report the review
  // flagged. A stale file must survive an empty rebuild attempt.
  it('does not overwrite an existing non-empty meta file with an empty rebuild', async () => {
    const transcript = path.join(tmp, 'c1.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'user', promptId: 'p', uuid: 'u', timestamp: '2026-07-26T18:04:11.000Z',
      message: { role: 'user', content: 'the indexed message' },
    }) + '\n');

    // First, a normal successful build establishes a good, non-empty file.
    await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{
        provider: 'claude', lane: 'claude', records: [rec()], resolveTranscriptPath: () => transcript,
      }],
      tagLabels: new Map(),
    });
    const dir = chatsearchDir(tmp);
    const goodMeta = fs.readFileSync(metaPath(dir, 'claude'), 'utf8');
    expect(JSON.parse(goodMeta).conversations.c1).toBeTruthy();

    // Simulate the store read failing this cycle: refreshFromLiveState's
    // .catch(() => []) hands refreshChatsearchIndex an empty records array,
    // exactly like a transiently unreadable sync space would.
    await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{ provider: 'claude', lane: 'claude', records: [], resolveTranscriptPath: () => transcript }],
      tagLabels: new Map(),
    });

    // The good file must be untouched — same bytes, same stale-but-honest refreshedAt.
    expect(fs.readFileSync(metaPath(dir, 'claude'), 'utf8')).toBe(goodMeta);
  });

  // The other edge: a genuinely empty index (no prior file) must still write
  // normally — the guard above only protects an EXISTING non-empty file, never
  // blocks the very first build.
  it('still writes an empty meta file on the very first build', async () => {
    await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{ provider: 'claude', lane: 'claude', records: [], resolveTranscriptPath: () => '/nope' }],
      tagLabels: new Map(),
    });

    const meta = JSON.parse(fs.readFileSync(metaPath(chatsearchDir(tmp), 'claude'), 'utf8'));
    expect(meta.conversations).toEqual({});
  });

  // MINOR finding: meta-builder.ts's laneMatches filter must be applied to the
  // TURNS pass too (not just the metadata pass), or a lane-mismatched record
  // gets turn lines written with no metadata row to join against — an entry
  // the CLI can find turns for but never list, tag, or resolve a title for.
  it('excludes a lane-mismatched record from the turns pass, matching the meta pass', async () => {
    const transcript = path.join(tmp, 'wrong-lane.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'user', promptId: 'p', uuid: 'u', timestamp: '2026-07-26T18:04:11.000Z',
      message: { role: 'user', content: 'should never be indexed under claude' },
    }) + '\n');

    await refreshChatsearchIndex({
      homeRoot: tmp,
      lanes: [{
        provider: 'claude',
        lane: 'claude',
        // transcriptRef points at the NATIVE lane, not claude's own — laneMatches('claude', ...) is false.
        records: [rec({ transcriptRef: 'native/sessions/x/c1.jsonl' })],
        resolveTranscriptPath: () => transcript,
      }],
      tagLabels: new Map(),
    });

    const dir = chatsearchDir(tmp);
    const meta = JSON.parse(fs.readFileSync(metaPath(dir, 'claude'), 'utf8'));
    expect(meta.conversations.c1).toBeUndefined();
    // No turns file should be written at all for a lane with zero eligible conversations.
    expect(fs.existsSync(turnsPath(dir, 'claude'))).toBe(false);
  });
});
