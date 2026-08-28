import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WHY these mocks and not fs: the drainer's contract is "apply through the real
// store functions and broadcast" — we assert on the calls, and use real files
// in a tmp home for the mailbox itself (same rule as chatsearch-index-reschedule).
const flagCalls: any[] = []; const noteCalls: any[] = []; const broadcasts: any[] = [];
let metaChanged = 0; let storeAvailable = true;
const records = new Map<string, { note: string; flags: Record<string, { value: boolean }> }>();
vi.mock('../src/main/conversations/service', () => ({
  getConversationStore: () => storeAvailable ? {
    root: () => '/store/A',
    get: async (_p: string, id: string) => records.get(id) ?? null,
  } : null,
  noteFlagChanged: async (id: string, flag: string, value: boolean) => { flagCalls.push([id, flag, value]); return { ok: true }; },
  noteSessionNote: async (id: string, note: string) => { noteCalls.push([id, note]); return { ok: true }; },
  emitConversationMetaChanged: () => { metaChanged++; },
}));
const tags = [{ id: 'tag_1', label: 'sync', color: 'tag-blue', archived: false, createdAt: '' }];
const created: any[] = [];
vi.mock('../src/main/conversations/tag-registry-service', () => ({
  getTagRegistry: () => ({
    list: async () => tags,
    create: async (label: string, color: string) => { const t = { id: `tag_${label}`, label, color, archived: false, createdAt: '' }; tags.push(t); created.push(t); return t; },
  }),
}));
vi.mock('../src/main/ipc-handlers', () => ({ broadcastSessionMeta: (id: string, p: any) => { broadcasts.push([id, p]); } }));

import { parseOutboxRequest, appendNoteText, hasDatedLine } from '../src/main/chatsearch-index/outbox-format';
import { applyOutboxRequest, drainOutboxOnce, outboxDir } from '../src/main/chatsearch-index/outbox-drain';

let home: string;
const req = (ops: any[], extra: Partial<any> = {}) => ({
  v: 1, id: '11111111-2222-3333-4444-555555555555', createdAt: '2026-08-27T00:00:00.000Z', storeRoot: '/store/A', ops, ...extra,
});
const T = [{ provider: 'claude', id: 'c1' }];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-outbox-'));
  flagCalls.length = 0; noteCalls.length = 0; broadcasts.length = 0; created.length = 0; metaChanged = 0; storeAvailable = true;
  records.clear();
  records.set('c1', { note: '', flags: {} });
  records.set('c2', { note: 'old', flags: { complete: { value: true } } });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('parseOutboxRequest', () => {
  it('rejects non-JSON with the parser message', () => {
    const r = parseOutboxRequest('{nope');
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });
  it('rejects a wrong version', () => {
    const r = parseOutboxRequest(JSON.stringify(req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { v: 2 })));
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/version 2/);
  });
  it('accepts a well-formed request', () => {
    const r = parseOutboxRequest(JSON.stringify(req([{ op: 'tag', targets: T, add: ['sync'] }])));
    expect(r.ok).toBe(true);
  });
});

describe('appendNoteText', () => {
  it('no leading newlines on an empty note', () => { expect(appendNoteText('', '2026-08-27', 'x')).toBe('2026-08-27: x'); });
  it('two newlines after an existing note', () => { expect(appendNoteText('old', '2026-08-27', 'x')).toBe('old\n\n2026-08-27: x'); });
});

describe('hasDatedLine', () => {
  it('matches on the text, whatever the date', () => {
    expect(hasDatedLine('old\n\n2026-08-26: superseded', 'superseded')).toBe(true);
    expect(hasDatedLine('old\n\n2026-08-26: superseded by X', 'superseded')).toBe(false);
    expect(hasDatedLine('superseded', 'superseded')).toBe(false); // undated body text is not a dated line
  });
});

describe('applyOutboxRequest', () => {
  const deps = { appVersion: '9.9.9', today: () => '2026-08-27' };
  it('flag applies through noteFlagChanged and broadcasts', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: T, flag: 'complete', value: true }]) as any, deps);
    expect(rc.results).toEqual([{ provider: 'claude', id: 'c1', op: 'flag', status: 'applied' }]);
    expect(flagCalls).toEqual([['c1', 'complete', true]]);
    expect(broadcasts).toEqual([['c1', { flag: 'complete', value: true }]]);
    expect(metaChanged).toBe(1);
  });
  it('flag reports already when unchanged, and does not write', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: [{ provider: 'claude', id: 'c2' }], flag: 'complete', value: true }]) as any, deps);
    expect(rc.results[0].status).toBe('already'); expect(flagCalls).toEqual([]);
  });
  it('unknown id is not-found and the batch continues', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: [{ provider: 'claude', id: 'zz' }, ...T], flag: 'priority', value: true }]) as any, deps);
    expect(rc.results.map((r) => r.status)).toEqual(['not-found', 'applied']);
  });
  it('note set replaces; append adds a dated line', async () => {
    await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'set', text: 'hello' }]) as any, deps);
    await applyOutboxRequest(req([{ op: 'note', targets: [{ provider: 'claude', id: 'c2' }], mode: 'append', text: 'superseded' }]) as any, deps);
    expect(noteCalls).toEqual([['c1', 'hello'], ['c2', 'old\n\n2026-08-27: superseded']]);
    expect(broadcasts[1]).toEqual(['c2', { note: 'old\n\n2026-08-27: superseded' }]);
  });
  it('append past 8000 chars is refused, not truncated', async () => {
    records.set('c1', { note: 'x'.repeat(7990), flags: {} });
    const rc = await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'append', text: 'y'.repeat(20) }]) as any, deps);
    expect(rc.results[0].status).toBe('refused'); expect(rc.results[0].error).toMatch(/8000/); expect(noteCalls).toEqual([]);
  });
  it('append is idempotent — a line already in the note reports already and writes nothing', async () => {
    records.set('c1', { note: 'old\n\n2026-08-26: superseded', flags: {} });
    const rc = await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'append', text: 'superseded' }]) as any, deps);
    expect(rc.results[0].status).toBe('already'); expect(noteCalls).toEqual([]);
  });
  it('no store → every target is an error, never not-found', async () => {
    storeAvailable = false;
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: T, flag: 'complete', value: true }]) as any, deps);
    expect(rc.results[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/storage is not available/) });
    expect(flagCalls).toEqual([]);
  });
  it('unknown tag is refused with the existing labels; create:true creates once', async () => {
    const r1 = await applyOutboxRequest(req([{ op: 'tag', targets: T, add: ['perms'], remove: [] }]) as any, deps);
    expect(r1.results[0].status).toBe('refused'); expect(r1.results[0].error).toMatch(/unknown tag "perms" — existing tags: sync/);
    const r2 = await applyOutboxRequest(req([{ op: 'tag', targets: [{ provider: 'claude', id: 'c1' }, { provider: 'claude', id: 'c2' }], add: ['perms'], remove: [], create: true }]) as any, deps);
    expect(created).toHaveLength(1); expect(r2.createdTags).toEqual([{ id: 'tag_perms', label: 'perms' }]);
    expect(flagCalls).toEqual([['c1', 'tag:tag_perms', true], ['c2', 'tag:tag_perms', true]]);
  });
  it('tag matches labels case-insensitively and removes via value:false', async () => {
    records.set('c1', { note: '', flags: { 'tag:tag_1': { value: true } } });
    const rc = await applyOutboxRequest(req([{ op: 'tag', targets: T, add: [], remove: ['SYNC'] }]) as any, deps);
    expect(rc.results[0].status).toBe('applied'); expect(flagCalls).toEqual([['c1', 'tag:tag_1', false]]);
  });
});

describe('drainOutboxOnce', () => {
  const write = (name: string, body: unknown) => {
    const dir = outboxDir(home); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const opts = () => ({ homeRoot: home, storeRoot: '/store/A', isDevInstance: false, appVersion: '9.9.9', today: () => '2026-08-27' });
  it('applies a request and writes a receipt; processing is emptied', async () => {
    write('11111111-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    expect(await drainOutboxOnce(opts())).toBe(1);
    const ack = JSON.parse(fs.readFileSync(path.join(outboxDir(home), 'done', '11111111-2222-3333-4444-555555555555.ack.json'), 'utf8'));
    expect(ack.results[0].status).toBe('applied');
    expect(fs.readdirSync(path.join(outboxDir(home), 'processing'))).toEqual([]);
  });
  it('malformed file gets an error receipt', async () => {
    write('22222222-2222-3333-4444-555555555555.json', '{nope');
    await drainOutboxOnce(opts());
    const ack = JSON.parse(fs.readFileSync(path.join(outboxDir(home), 'done', '22222222-2222-3333-4444-555555555555.ack.json'), 'utf8'));
    expect(ack.error).toMatch(/not valid JSON/); expect(ack.results).toEqual([]);
  });
  it('a request for another store is left in outbox untouched', async () => {
    write('33333333-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { storeRoot: '/store/B' }));
    expect(await drainOutboxOnce(opts())).toBe(0);
    expect(fs.existsSync(path.join(outboxDir(home), '33333333-2222-3333-4444-555555555555.json'))).toBe(true);
    expect(flagCalls).toEqual([]);
  });
  it('a dev instance never drains unless overridden', async () => {
    write('44444444-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    expect(await drainOutboxOnce({ ...opts(), isDevInstance: true })).toBe(0);
    expect(await drainOutboxOnce({ ...opts(), isDevInstance: true, devOverride: true })).toBe(1);
  });
  it('stale processing entries are recovered', async () => {
    const proc = path.join(outboxDir(home), 'processing'); fs.mkdirSync(proc, { recursive: true });
    const p = path.join(proc, '55555555-2222-3333-4444-555555555555.json');
    fs.writeFileSync(p, JSON.stringify(req([{ op: 'flag', targets: T, flag: 'complete', value: true }])));
    const old = new Date(Date.now() - 11 * 60_000); fs.utimesSync(p, old, old);
    expect(await drainOutboxOnce(opts())).toBe(1);
  });
  it('receipts older than 24h are swept', async () => {
    const done = path.join(outboxDir(home), 'done'); fs.mkdirSync(done, { recursive: true });
    const p = path.join(done, 'old.ack.json'); fs.writeFileSync(p, '{}');
    const old = new Date(Date.now() - 25 * 3600_000); fs.utimesSync(p, old, old);
    await drainOutboxOnce(opts());
    expect(fs.existsSync(p)).toBe(false);
  });
  it('a file another instance already claimed is skipped, not applied twice', async () => {
    // WHY not two drainers in Promise.all: everything up to the rename claim is
    // synchronous, so the second call would always see an empty folder and the
    // test would pass without exercising the race. Simulate the loser instead.
    write('66666666-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    const proc = path.join(outboxDir(home), 'processing'); fs.mkdirSync(proc, { recursive: true });
    fs.renameSync(path.join(outboxDir(home), '66666666-2222-3333-4444-555555555555.json'), path.join(proc, '66666666-2222-3333-4444-555555555555.json'));
    expect(await drainOutboxOnce(opts())).toBe(0);
    expect(flagCalls).toEqual([]);
  });
});
