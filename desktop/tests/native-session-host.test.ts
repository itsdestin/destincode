import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

// RAW V4 stream-part shapes (see harness-session.test.ts): deltas carry `delta`, usage is nested.
const CHUNKS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Hi there' },
  { type: 'text-end', id: 'p1' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } } },
];
const factory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: CHUNKS }) }) }) as any;

describe('NativeSessionHost', () => {
  let root: string; let host: NativeSessionHost;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
  });
  afterEach(async () => { await host.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  it('create → send → events forwarded AND persisted; getHistory replays them', async () => {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.send('s-1', 'hello');
    await host.drain('s-1');   // wait for the append chain to settle
    expect(seen.map((e) => e.type)).toContain('turn-complete');
    const history = host.getHistory('s-1');
    expect(history).not.toBeNull();
    expect(history!.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(history![1].data.text).toBe('Hi there');   // coalesced on disk
  });

  it('resume rebuilds a live session whose history includes the stored exchange', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.send('s-1', 'hello');
    await host.drain('s-1');
    await host.destroyAll();

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
    const resumed = await host2.resume('s-1', root);
    expect(resumed).toBe(true);
    expect(host2.getHistory('s-1')!.length).toBe(3);
    await host2.send('s-1', 'again');
    await host2.drain('s-1');
    await host2.destroyAll();
  });

  it('list() surfaces sessions for the Resume Browser with provider tag', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const rows = host.list();
    expect(rows[0]).toMatchObject({ sessionId: 's-1', provider: 'native' });
  });

  it('getHistory returns null for unknown/non-native sessions (replay falls through to CC)', () => {
    expect(host.getHistory('nope')).toBeNull();
  });

  it('send to an unknown session returns false, does not throw', async () => {
    expect(await host.send('ghost', 'x')).toBe(false);
  });
});
