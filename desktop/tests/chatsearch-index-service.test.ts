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
});
