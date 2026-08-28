import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { chatsearchDir } from './index-store';
import {
  NOTE_MAX_CHARS, OUTBOX_FORMAT_VERSION, parseOutboxRequest, appendNoteText, hasDatedLine,
  type OutboxRequest, type OutboxReceipt, type ReceiptResult, type OutboxTarget,
} from './outbox-format';
import { getConversationStore, noteFlagChanged, noteSessionNote, emitConversationMetaChanged } from '../conversations/service';
import { getTagRegistry } from '../conversations/tag-registry-service';
import { broadcastSessionMeta } from '../ipc-handlers';
import { tagFlagKey, DEFAULT_TAG_COLOR } from '../../shared/tags';
import { log } from '../logger';

const POLL_MS = 5_000;
const RECEIPT_TTL_MS = 24 * 3600_000;
const PROCESSING_STALE_MS = 10 * 60_000;
type Store = NonNullable<ReturnType<typeof getConversationStore>>;
const STORE_DOWN = 'conversation storage is not available right now — retry with YouCoded open';

export function outboxDir(homeRoot: string): string { return path.join(chatsearchDir(homeRoot), 'outbox'); }

export interface ApplyDeps { appVersion: string; today: () => string }
export interface DrainOpts extends ApplyDeps {
  homeRoot: string; storeRoot: string; isDevInstance: boolean; devOverride?: boolean;
}

function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

async function applyFlag(store: Store, t: OutboxTarget, flagKey: string, value: boolean): Promise<ReceiptResult> {
  const rec = await store.get(t.provider, t.id);
  if (!rec) return { ...t, op: 'flag', status: 'not-found' };
  const current = rec.flags?.[flagKey]?.value === true;
  if (current === value) return { ...t, op: 'flag', status: 'already' };
  // WHY knownNative=false: the drainer never sees live desktop ids, so the
  // store probe inside noteFlagChanged is the right provider decision.
  const res = await noteFlagChanged(t.id, flagKey, value, t.provider === 'native');
  if (!res.ok) return { ...t, op: 'flag', status: 'error', error: 'Could not save — conversation storage is not available on this device.' };
  broadcastSessionMeta(t.id, { flag: flagKey, value });
  return { ...t, op: 'flag', status: 'applied' };
}

export async function applyOutboxRequest(req: OutboxRequest, deps: ApplyDeps): Promise<OutboxReceipt> {
  const results: ReceiptResult[] = [];
  const createdTags: Array<{ id: string; label: string }> = [];
  const receipt = (): OutboxReceipt => ({ v: OUTBOX_FORMAT_VERSION, id: req.id, appliedAt: new Date().toISOString(), appVersion: deps.appVersion, results, createdTags });
  const store = getConversationStore();
  // WHY error and not not-found: the store is null only while starting or after
  // quit began. "Not found" would be a wrong, permanent answer for a real conversation.
  if (!store) {
    for (const op of req.ops) for (const t of op.targets) results.push({ ...t, op: op.op, status: 'error', error: STORE_DOWN });
    return receipt();
  }

  for (const op of req.ops) {
    if (op.op === 'flag') {
      for (const t of op.targets) results.push(await applyFlag(store, t, op.flag, op.value));
    } else if (op.op === 'note') {
      for (const t of op.targets) {
        const rec = await store.get(t.provider, t.id);
        if (!rec) { results.push({ ...t, op: 'note', status: 'not-found' }); continue; }
        if (op.mode === 'append' && hasDatedLine(rec.note ?? '', op.text)) { results.push({ ...t, op: 'note', status: 'already' }); continue; }
        const next = op.mode === 'set' ? op.text : appendNoteText(rec.note ?? '', deps.today(), op.text);
        if (next.length > NOTE_MAX_CHARS) { results.push({ ...t, op: 'note', status: 'refused', error: `note would exceed ${NOTE_MAX_CHARS} characters (${next.length})` }); continue; }
        if (next === (rec.note ?? '')) { results.push({ ...t, op: 'note', status: 'already' }); continue; }
        const res = await noteSessionNote(t.id, next, t.provider === 'native');
        if (!res.ok) { results.push({ ...t, op: 'note', status: 'error', error: 'Could not save — conversation storage is not available on this device.' }); continue; }
        broadcastSessionMeta(t.id, { note: next });
        results.push({ ...t, op: 'note', status: 'applied' });
      }
    } else if (op.op === 'tag') {
      const reg = getTagRegistry();
      if (!reg) { for (const t of op.targets) results.push({ ...t, op: 'tag', status: 'error', error: 'tag registry unavailable' }); continue; }
      const all = (await reg.list()).filter((x) => !x.archived);
      const byLabel = new Map(all.map((x) => [x.label.toLowerCase(), x]));
      const resolve = async (label: string, allowCreate: boolean) => {
        const hit = byLabel.get(label.toLowerCase());
        if (hit) return hit;
        if (!allowCreate) return null;
        const made = await reg.create(label, DEFAULT_TAG_COLOR);
        byLabel.set(label.toLowerCase(), made); createdTags.push({ id: made.id, label: made.label });
        return made;
      };
      // WHY resolve before touching any target: an unknown label refuses the
      // whole op — partial application across 22 conversations is worse than none.
      const adds = []; const removes = []; let refused: string | null = null;
      for (const l of op.add) { const r = await resolve(l, op.create); if (!r) { refused = l; break; } adds.push(r); }
      if (!refused) for (const l of op.remove) { const r = await resolve(l, false); if (!r) { refused = l; break; } removes.push(r); }
      if (refused) {
        const existing = all.map((x) => x.label).sort().join(', ') || '(none)';
        for (const t of op.targets) results.push({ ...t, op: 'tag', status: 'refused', error: `unknown tag "${refused}" — existing tags: ${existing}` });
        continue;
      }
      for (const t of op.targets) {
        let worst: ReceiptResult | null = null; let applied = false;
        for (const [tag, value] of [...adds.map((a) => [a, true] as const), ...removes.map((r) => [r, false] as const)]) {
          const r = await applyFlag(store, t, tagFlagKey(tag.id), value);
          if (r.status === 'applied') applied = true;
          if (r.status === 'not-found' || r.status === 'error') { worst = { ...r, op: 'tag' }; break; }
        }
        results.push(worst ?? { ...t, op: 'tag', status: applied ? 'applied' : 'already' });
      }
    }
  }
  if (results.some((r) => r.status === 'applied')) emitConversationMetaChanged();
  return receipt();
}

function recoverStaleProcessing(dir: string): void {
  const proc = path.join(dir, 'processing');
  let names: string[] = [];
  try { names = fs.readdirSync(proc); } catch { return; }
  for (const n of names) {
    const p = path.join(proc, n);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > PROCESSING_STALE_MS) fs.renameSync(p, path.join(dir, n));
    } catch { /* another instance got there first */ }
  }
}

function sweepReceipts(dir: string): void {
  const done = path.join(dir, 'done');
  let names: string[] = [];
  try { names = fs.readdirSync(done); } catch { return; }
  for (const n of names) {
    const p = path.join(done, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > RECEIPT_TTL_MS) fs.unlinkSync(p); } catch { /* best effort */ }
  }
}

/** One pass over the outbox. Returns how many requests this instance handled. */
export async function drainOutboxOnce(opts: DrainOpts): Promise<number> {
  if (opts.isDevInstance && !opts.devOverride) return 0;
  const dir = outboxDir(opts.homeRoot);
  if (!fs.existsSync(dir)) return 0;
  recoverStaleProcessing(dir);
  sweepReceipts(dir);
  let handled = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue; // the CLI's temp files end in .tmp-<pid>, so they never match
    const src = path.join(dir, name);
    let raw: string;
    try { raw = fs.readFileSync(src, 'utf8'); } catch { continue; }
    const parsed = parseOutboxRequest(raw);
    // WHY check storeRoot BEFORE claiming: a request for another store must stay
    // visible to the instance it belongs to.
    if (parsed.ok && parsed.req.storeRoot !== opts.storeRoot) {
      log('INFO', 'chatsearch-outbox', 'request for another store left in place', { id: parsed.req.id, storeRoot: parsed.req.storeRoot });
      continue;
    }
    const claimed = path.join(dir, 'processing', name);
    fs.mkdirSync(path.dirname(claimed), { recursive: true });
    try { fs.renameSync(src, claimed); } catch { continue; } // lost the race
    const id = name.replace(/\.json$/, '');
    let receipt: OutboxReceipt;
    if (!parsed.ok) {
      receipt = { v: OUTBOX_FORMAT_VERSION, id, appliedAt: new Date().toISOString(), appVersion: opts.appVersion, results: [], createdTags: [], error: parsed.error };
    } else {
      try { receipt = await applyOutboxRequest(parsed.req, opts); }
      catch (e: any) {
        receipt = { v: OUTBOX_FORMAT_VERSION, id, appliedAt: new Date().toISOString(), appVersion: opts.appVersion, results: [], createdTags: [], error: `apply failed — ${e?.message ?? String(e)}` };
      }
    }
    writeJsonAtomic(path.join(dir, 'done', `${id}.ack.json`), receipt);
    try { fs.unlinkSync(claimed); } catch { /* already gone */ }
    handled++;
  }
  return handled;
}

// ---- lifecycle -------------------------------------------------------------
let watcher: fs.FSWatcher | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

function liveOpts(): DrainOpts | null {
  const store = getConversationStore();
  if (!store) return null;
  return {
    homeRoot: os.homedir(), storeRoot: store.root(),
    isDevInstance: !!process.env.YOUCODED_PROFILE, devOverride: process.env.YOUCODED_CHATSEARCH_OUTBOX === '1',
    appVersion: app?.getVersion?.() ?? 'dev', today: () => new Date().toISOString().slice(0, 10),
  };
}

async function drainSerialized(): Promise<void> {
  if (running) { rerun = true; return; }
  running = true;
  try {
    do { rerun = false; const o = liveOpts(); if (o) await drainOutboxOnce(o); } while (rerun);
  } catch (e: any) {
    log('WARN', 'chatsearch-outbox', 'drain failed', { error: e?.message ?? String(e) });
  } finally { running = false; }
}

export function startOutboxDrain(): void {
  stopOutboxDrain();
  const dir = outboxDir(os.homedir());
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* drain will no-op */ }
  try {
    watcher = fs.watch(dir, () => { void drainSerialized(); });
    watcher.on('error', () => { watcher?.close(); watcher = null; });
  } catch { watcher = null; }
  // WHY a poll alongside fs.watch: Windows drops notifications; 5 s matches subagent-watcher.
  // Every pass also sweeps old receipts, so no separate sweep timer exists.
  pollTimer = setInterval(() => { void drainSerialized(); }, POLL_MS); pollTimer.unref?.();
  void drainSerialized(); // launch drain — requests queued while the app was closed
}

export function stopOutboxDrain(): void {
  watcher?.close(); watcher = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
