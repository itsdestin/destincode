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

  // session-error is a turn boundary: it must flush the open part (the partial
  // assistant text the user already saw live) even though its own line is
  // display-only and never hits disk.
  it('session-error flushes the open part but is not itself persisted', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('session-error', { text: 'boom' }, 'e1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text']);
    expect((events[0] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
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

  it('dispose flushes the in-flight part and clears the open buffer', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'partial', partId: 'p1' }, 'a1') as any);
    await store.dispose('s-1'); // graceful mid-stream teardown — must persist the part
    // The part is now on disk...
    expect(store.readEvents('s-1', HEADER.cwd)).toMatchObject([{ type: 'assistant-text', data: { text: 'partial' } }]);
    // ...and the open map no longer holds it: a follow-up delta with the SAME
    // partId opens a FRESH part instead of concatenating onto the disposed one.
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'second', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const texts = store.readEvents('s-1', HEADER.cwd).filter((e: any) => e.type === 'assistant-text').map((e: any) => e.data.text);
    expect(texts).toEqual(['partial', 'second']); // two separate parts, not 'partialsecond'
  });

  it('flushAll flushes open parts across multiple sessions', async () => {
    const HEADER2: NativeSessionHeader = { ...HEADER, sessionId: 's-2' };
    const ev2 = (type: string, data: any, uuid: string) => ({ type, sessionId: 's-2', uuid, timestamp: 1720600001000, data });
    await store.create(HEADER);
    await store.create(HEADER2);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'one', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER2.cwd, ev2('assistant-text', { text: 'two', partId: 'p1' }, 'b1') as any);
    await store.flushAll();
    expect(store.readEvents('s-1', HEADER.cwd)).toMatchObject([{ data: { text: 'one' } }]);
    expect(store.readEvents('s-2', HEADER2.cwd)).toMatchObject([{ data: { text: 'two' } }]);
  });

  it('preserves ordering across multiple turns', async () => {
    await store.create(HEADER);
    // Turn 1
    await store.append(HEADER.cwd, ev('user-message', { text: 'q1' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'a1', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    // Turn 2
    await store.append(HEADER.cwd, ev('user-message', { text: 'q2' }, 'u2') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'a2', partId: 'p2' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't2') as any);
    const types = store.readEvents('s-1', HEADER.cwd).map((e: any) => e.type);
    expect(types).toEqual(['user-message', 'assistant-text', 'turn-complete', 'user-message', 'assistant-text', 'turn-complete']);
  });

  it('coalesces interleaved reasoning/text parts within one turn, in order', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: 'think-a', partId: 'r1' }, 'r1a') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: '-b', partId: 'r1' }, 'r1b') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'answer', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: 'more-think', partId: 'r2' }, 'r2a') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-thinking', 'assistant-text', 'assistant-thinking', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'think-a-b', partId: 'r1' });
    expect((events[1] as any).data).toMatchObject({ text: 'answer', partId: 'p1' });
    expect((events[2] as any).data).toMatchObject({ text: 'more-think', partId: 'r2' });
  });

  // Passthrough pin (Task 10): tool-use / tool-result are NON-delta events, so
  // append persists them VERBATIM (no coalescing) — a resume rebuild depends on
  // reading them back byte-for-byte, INCLUDING the Edit/MultiEdit structuredPatch
  // hunks that the ToolCard diff view renders. This is the store half of the
  // resume contract (rebuildHistory is the other half).
  it('round-trips a tool-use/tool-result pair through append→readEvents unchanged (incl. structuredPatch)', async () => {
    await store.create(HEADER);
    const useEvent = ev('tool-use', {
      toolUseId: 'call-1', toolName: 'Edit', toolInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
    }, 'tu1') as any;
    const structuredPatch = [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' ctx', '-x', '+y'] },
    ];
    const resultEvent = ev('tool-result', {
      toolUseId: 'call-1', toolName: 'Edit', toolResult: 'Edited a.ts', isError: false, structuredPatch,
    }, 'tr1') as any;
    await store.append(HEADER.cwd, useEvent);
    await store.append(HEADER.cwd, resultEvent);
    const events = store.readEvents('s-1', HEADER.cwd);
    // Deep-equal both events verbatim — nothing coalesced, nothing dropped, and
    // the nested structuredPatch survives the JSON round-trip intact.
    expect(events).toEqual([useEvent, resultEvent]);
    expect((events[1] as any).data.structuredPatch).toEqual(structuredPatch);
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
