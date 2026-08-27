import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onConversationMetaChanged, emitConversationMetaChanged } from '../src/main/conversations/service';
import { refreshChatsearchIndex, resolveTranscriptPathTwoStep } from '../src/main/chatsearch-index/index-service';
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
      storeRoot: tmp,
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
      storeRoot: tmp,
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
      storeRoot: tmp,
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
      storeRoot: tmp,
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
      storeRoot: tmp,
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
      storeRoot: tmp,
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
      storeRoot: tmp,
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

// 2026-08 fix: both lanes used to resolve ONLY a device-local path derived
// from originalPath. That path never exists for a record with an empty
// originalPath, or one synced from another device (whose originalPath is
// that machine's own filesystem layout) — on real data this mis-tombstoned
// 91% of the claude lane, reporting conversations deleted when 400/400
// sampled ones were actually present in the synced space. These tests pin
// resolveTranscriptPathTwoStep's local-first, space-mirror-backstop order.
describe('resolveTranscriptPathTwoStep (synced-space backstop)', () => {
  const userMsg = (content: string) => `${JSON.stringify({
    type: 'user', promptId: 'p', uuid: 'u', timestamp: '2026-07-26T18:04:11.000Z',
    message: { role: 'user', content },
  })}\n`;

  it('falls back to the synced-space transcript when the local copy is missing', async () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const spaceTranscript = path.join(storeRoot, 'claude', 'transcripts', 'youcoded', 'c1.jsonl');
    fs.mkdirSync(path.dirname(spaceTranscript), { recursive: true });
    fs.writeFileSync(spaceTranscript, userMsg('from the synced space'));

    const localPath = path.join(tmp, 'no-such-local.jsonl'); // never created

    await refreshChatsearchIndex({
      homeRoot: tmp,
      storeRoot: tmp,
      lanes: [{
        provider: 'claude', lane: 'claude', records: [rec()],
        resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(r, localPath, storeRoot),
      }],
      tagLabels: new Map(),
    });

    const dir = chatsearchDir(tmp);
    const meta = JSON.parse(fs.readFileSync(metaPath(dir, 'claude'), 'utf8'));
    expect(meta.conversations.c1.tombstone).toBe(false);
    expect(meta.conversations.c1.turnCount).toBe(1);
    expect(fs.readFileSync(turnsPath(dir, 'claude'), 'utf8')).toContain('from the synced space');
  });

  it('prefers the local copy when both the local file and the synced-space mirror exist', async () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const spaceTranscript = path.join(storeRoot, 'claude', 'transcripts', 'youcoded', 'c1.jsonl');
    fs.mkdirSync(path.dirname(spaceTranscript), { recursive: true });
    fs.writeFileSync(spaceTranscript, userMsg('stale space copy'));

    const localPath = path.join(tmp, 'local.jsonl');
    fs.writeFileSync(localPath, userMsg('live local copy'));

    await refreshChatsearchIndex({
      homeRoot: tmp,
      storeRoot: tmp,
      lanes: [{
        provider: 'claude', lane: 'claude', records: [rec()],
        resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(r, localPath, storeRoot),
      }],
      tagLabels: new Map(),
    });

    const dir = chatsearchDir(tmp);
    const turns = fs.readFileSync(turnsPath(dir, 'claude'), 'utf8');
    expect(turns).toContain('live local copy');
    expect(turns).not.toContain('stale space copy');
  });

  it('tombstones when the transcript exists in neither the local path nor the synced space', async () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const localPath = path.join(tmp, 'never-created.jsonl');

    await refreshChatsearchIndex({
      homeRoot: tmp,
      storeRoot: tmp,
      lanes: [{
        provider: 'claude', lane: 'claude', records: [rec()],
        resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(r, localPath, storeRoot),
      }],
      tagLabels: new Map(),
    });

    const meta = JSON.parse(fs.readFileSync(metaPath(chatsearchDir(tmp), 'claude'), 'utf8'));
    expect(meta.conversations.c1.tombstone).toBe(true);
  });

  it('does not prefer the local path when originalPath is empty, even if a file happens to exist there', () => {
    // Guards the "empty originalPath" half of the bug: the join still
    // produces SOME path, so existence alone is not a safe signal that it's
    // really this record's live local copy.
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const spaceTranscript = path.join(storeRoot, 'claude', 'transcripts', 'youcoded', 'c1.jsonl');
    fs.mkdirSync(path.dirname(spaceTranscript), { recursive: true });
    fs.writeFileSync(spaceTranscript, userMsg('space'));

    const localPath = path.join(tmp, 'coincidental-local.jsonl');
    fs.writeFileSync(localPath, userMsg('local')); // exists, but originalPath below is empty

    const resolved = resolveTranscriptPathTwoStep(rec({ originalPath: '' }), localPath, storeRoot);
    expect(resolved).toBe(spaceTranscript);
  });

  it('refuses a transcriptRef that traverses outside the store root', () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    // A secret file OUTSIDE storeRoot that a traversal must never reach.
    const secret = path.join(tmp, 'secret.jsonl');
    fs.writeFileSync(secret, 'top secret contents');

    const localPath = path.join(tmp, 'no-such-local.jsonl');
    const maliciousRef = path.relative(storeRoot, secret); // e.g. '../secret.jsonl'
    expect(maliciousRef.startsWith('..')).toBe(true);

    const resolved = resolveTranscriptPathTwoStep(rec({ transcriptRef: maliciousRef }), localPath, storeRoot);

    // Must never resolve to the secret file outside root — falls back to the
    // (nonexistent) local guess so the record tombstones honestly instead of
    // silently reading a path escaping the store.
    expect(resolved).toBe(localPath);
    expect(resolved).not.toBe(secret);
  });

  it('a malicious transcriptRef never surfaces its target contents through the built index', async () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const secret = path.join(tmp, 'secret.jsonl');
    fs.writeFileSync(secret, userMsg('SECRET OUTSIDE THE STORE ROOT'));

    const localPath = path.join(tmp, 'no-such-local.jsonl');
    const maliciousRef = path.relative(storeRoot, secret).split(path.sep).join('/');

    await refreshChatsearchIndex({
      homeRoot: tmp,
      storeRoot: tmp,
      lanes: [{
        provider: 'claude',
        lane: 'claude',
        records: [rec({ transcriptRef: maliciousRef })],
        resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(r, localPath, storeRoot),
      }],
      tagLabels: new Map(),
    });

    // A ref starting with '..' also fails laneMatches's 'claude/' prefix
    // check, so this record may be excluded from the pass entirely — either
    // way, the secret content must never appear in the index.
    const dir = chatsearchDir(tmp);
    if (fs.existsSync(turnsPath(dir, 'claude'))) {
      expect(fs.readFileSync(turnsPath(dir, 'claude'), 'utf8')).not.toContain('SECRET OUTSIDE');
    }
    if (fs.existsSync(metaPath(dir, 'claude'))) {
      const meta = JSON.parse(fs.readFileSync(metaPath(dir, 'claude'), 'utf8'));
      if (meta.conversations.c1) expect(meta.conversations.c1.tombstone).toBe(true);
    }
  });

  // Native transcripts use a different line format than claude's — a header
  // line (skipped) followed by { type: 'user-message', data: { text } } lines
  // (see extractNativeUserTurns in index-core.ts) — so the claude-shaped
  // userMsg() fixture above does not apply here.
  const nativeTranscript = (text: string) => [
    JSON.stringify({ type: 'session-header', sessionId: 'c1' }),
    JSON.stringify({
      type: 'user-message', timestamp: '2026-07-26T18:04:11.000Z', data: { text },
    }),
    '',
  ].join('\n');

  it('covers the native lane with the same synced-space fallback', async () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const spaceTranscript = path.join(storeRoot, 'native', 'transcripts', 'youcoded', 'c1.jsonl');
    fs.mkdirSync(path.dirname(spaceTranscript), { recursive: true });
    fs.writeFileSync(spaceTranscript, nativeTranscript('native lane from synced space'));

    const localPath = path.join(tmp, 'no-such-native-local.jsonl');

    await refreshChatsearchIndex({
      homeRoot: tmp,
      storeRoot: tmp,
      lanes: [{
        provider: 'native',
        lane: 'native',
        records: [rec({ transcriptRef: 'native/transcripts/youcoded/c1.jsonl' })],
        resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(r, localPath, storeRoot),
      }],
      tagLabels: new Map(),
    });

    const dir = chatsearchDir(tmp);
    const meta = JSON.parse(fs.readFileSync(metaPath(dir, 'native'), 'utf8'));
    expect(meta.conversations.c1.tombstone).toBe(false);
    expect(fs.readFileSync(turnsPath(dir, 'native'), 'utf8')).toContain('native lane from synced space');
  });

  it('tombstones the native lane too when neither path resolves', async () => {
    const storeRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
    const localPath = path.join(tmp, 'never-created-native.jsonl');

    await refreshChatsearchIndex({
      homeRoot: tmp,
      storeRoot: tmp,
      lanes: [{
        provider: 'native',
        lane: 'native',
        records: [rec({ transcriptRef: 'native/transcripts/youcoded/c1.jsonl' })],
        resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(r, localPath, storeRoot),
      }],
      tagLabels: new Map(),
    });

    const meta = JSON.parse(fs.readFileSync(metaPath(chatsearchDir(tmp), 'native'), 'utf8'));
    expect(meta.conversations.c1.tombstone).toBe(true);
  });
});
