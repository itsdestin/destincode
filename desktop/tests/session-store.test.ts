// Contract for SessionStore — native session JSONL persistence (Phase 1 Task 7).
// Line 1 = header, lines 2+ = transcript events, per-partId delta coalescing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';

const HEADER: NativeSessionHeader = {
  v: 1,
  sessionId: 's-1',
  harnessId: 'chat',
  binding: { providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' },
  cwd: 'C:/Users/x/proj',
  createdAt: 1720600000000,
};
const ev = (type: string, data: any, uuid: string) => ({
  type,
  sessionId: 's-1',
  uuid,
  timestamp: 1720600001000,
  data,
});

describe('SessionStore', () => {
  let root: string;
  let store: SessionStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sstore-'));
    store = new SessionStore(new NativeHome(root));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('create writes the header as line 1; readHeader round-trips', async () => {
    await store.create(HEADER);
    expect(store.readHeader('s-1', HEADER.cwd)).toEqual(HEADER);
  });

  it('coalesces same-partId text deltas into ONE persisted event with concatenated text', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any); // flushes the open part
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect((events[1] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });

  it('never persists session-error events', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('session-error', { text: 'boom' }, 'e1') as any);
    expect(store.readEvents('s-1', HEADER.cwd)).toEqual([]);
  });

  it('a new partId flushes the previous open part', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: 'thi', partId: 'r1' }, 'r1a') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Answer', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const types = store.readEvents('s-1', HEADER.cwd).map((e: any) => e.type);
    expect(types).toEqual(['assistant-thinking', 'assistant-text', 'turn-complete']);
  });

  it('readEvents dedups by uuid', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any); // double-append
    expect(store.readEvents('s-1', HEADER.cwd)).toHaveLength(1);
  });

  it('list surfaces sessions with header metadata for the Resume Browser', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 's-1', cwd: 'C:/Users/x/proj', harnessId: 'chat' });
  });

  it('derives a title from the first user message when the header has none', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'explain quantum tunneling to me' }, 'u1') as any);
    expect(store.list()[0].title).toBe('explain quantum tunneling to me');
  });

  // Clone-semantics pin (Task 7 self-review requirement): the buffered open
  // part must be a CLONE — mutating the caller's event object after append()
  // returns must not change what ends up on disk.
  it('buffered deltas are clones — caller mutation after append does not leak into the file', async () => {
    await store.create(HEADER);
    const delta = ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any;
    await store.append(HEADER.cwd, delta);
    delta.data.text = 'CORRUPTED';
    delta.data.partId = 'poisoned';
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect((events[0] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });
});
