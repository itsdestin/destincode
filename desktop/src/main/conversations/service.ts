// desktop/src/main/conversations/service.ts
// Composition root for the Conversation Store (design §1–§2). Module singleton
// like sync-spaces/service.ts. Owns: the store instance, live transcript-event
// intake (debounced activity upserts; prompt mirror+push on turn-complete),
// title/flag write-through, the startup + periodic reconciler, and the
// materialize-on-synced subscription.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationStore, ConversationStore } from './conversation-store';
import { mirrorIn, materializeOut } from './transcript-mirror';
import { reconcile } from './reconciler';
import { ccProjectSlug } from '../project-conversations';
import { onSyncSpacesEvent, syncSpacesSyncNow, getManagedRoots } from '../sync-spaces/service';
import { readFolders } from '../saved-folders';
import { resolveLocalProject } from './resolve-local-project';
import type { TranscriptEvent } from '../../shared/types';
import type { SpaceSyncEvent } from '../sync-spaces/types';

const ACTIVITY_DEBOUNCE_MS = 5_000;
const RECONCILE_INTERVAL_MS = 30 * 60_000; // slow tick; the startup scan is the load-bearing one
// Bug 2 Part 2 (Plan 2b): session-exit fires BEFORE the PTY worker actually dies,
// so CC may still be flushing its final turn to the local transcript. Before the
// targeted materialize copies a peer's version over the local file, wait for the
// local file to stop growing — two equal-size stats this far apart = CC done.
const QUIESCE_PROBE_MS = 750;   // gap between size probes
const QUIESCE_MAX_MS = 6_000;   // give up waiting; skip this round (reconciler/startup sweep catch up)

interface SessionCtx { cwd: string }

let store: ConversationStore | null = null;
let projectsDir = '';
let topicsDir = '';
let device = '';
let unsubscribe: (() => void) | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
// Desktop hook wiring resolves the CLAUDE session id before calling in, so the
// map is keyed by claude id (matches the store's record id). cwd is learned via
// noteSessionStarted; events for never-announced sessions still upsert (the live
// path corrects projectName/originalPath the next time the session runs here).
const sessions = new Map<string, SessionCtx>();
const pendingActivity = new Map<string, NodeJS.Timeout>();

export function getConversationStore(): ConversationStore | null { return store; }

export async function startConversationStore(opts?: {
  conversationsRoot?: string; projectsDir?: string; topicsDir?: string; device?: string;
}): Promise<void> {
  // Idempotent start (review fix 4): a second start without a stop would leak
  // the first onSyncSpacesEvent subscription (duplicate materialize sweeps
  // forever) and the first periodic interval. Tearing down first keeps the
  // module a true singleton regardless of how callers sequence start/stop.
  stopConversationStore();
  const personalRoot = getManagedRoots()?.personalRoot;
  const root = opts?.conversationsRoot
    ?? (personalRoot ? path.join(personalRoot, 'Conversations') : null);
  if (!root) return; // managed roots unavailable — the store stays off this launch
  projectsDir = opts?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  topicsDir = opts?.topicsDir ?? path.join(os.homedir(), '.claude', 'topics');
  device = opts?.device ?? os.hostname();
  store = createConversationStore(root);

  // Carry-forward 3: subscribe ONCE and hold the unsubscribe. The listener Set
  // dedups identical fn refs, but a fresh closure each start would still leak.
  unsubscribe = onSyncSpacesEvent((e: SpaceSyncEvent) => {
    // Personal-space updates carry new/updated transcripts — sweep them out to
    // the CC projects dir so a session that ran on another device is resumable
    // here. Non-personal / non-updated events are ignored (the 'hub' sentinel
    // and project spaces never materialize conversations).
    if (e.type === 'synced' && e.spaceId === 'personal' && e.updated) void materializeSweep();
  });

  // Carry-forward 2: kick the reconciler DETACHED. The first-ever run mirrors
  // potentially GBs of transcripts (serial copies); awaiting it here would block
  // app startup. runReconcile swallows its own failures.
  runReconcile();

  // Catch-up materialize on startup (2026-07-13 two-device dogfood fix, Part 1).
  // The space->local sweep is otherwise ONLY triggered by a fresh Personal
  // 'synced+updated' event (see the subscription above). So a PEER device's
  // transcript that already landed in this device's local space during a PREVIOUS
  // run — either while its session was still guarded, or before this store was
  // watching — was never written into the local Claude Code projects dir the app
  // resumes from. Result: the conversation looked permanently stale on this
  // device (the continuation sat in the space, unseen). Running one sweep at
  // startup applies any already-synced peer version on launch. Detached +
  // never-throws, exactly like runReconcile above.
  //
  // Scope: this is the INBOUND-on-startup catch-up ONLY. Releasing the live guard
  // and re-sweeping the moment a session CLOSES (so a peer version applies without
  // needing a restart) is deferred to Plan 2b — it needs leases to be safe (see
  // the guard comment inside materializeSweep for why materializing over a live
  // transcript is dangerous without single-writer guarantees).
  void materializeSweep();

  reconcileTimer = setInterval(() => { runReconcile(); }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

export function stopConversationStore(): void {
  unsubscribe?.(); unsubscribe = null;
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  for (const t of pendingActivity.values()) clearTimeout(t);
  pendingActivity.clear();
  sessions.clear();
  store = null;
}

export function noteSessionStarted(claudeSessionId: string, cwd: string): void {
  sessions.set(claudeSessionId, { cwd });
}

// <root>/claude/transcripts/<projectKey>/<id>.jsonl — the durable space copy.
// projectKey is the portable project name (basename of cwd), matching the
// reconciler's transcriptRef convention (NOT the CC slug).
function spaceTranscriptPath(projectKey: string, sessionId: string): string {
  return path.join(store!.root(), 'claude', 'transcripts', projectKey, `${sessionId}.jsonl`);
}
// The CC on-disk transcript path for this session — projects dir + CC slug.
function localJsonlPath(cwd: string, sessionId: string): string {
  return path.join(projectsDir, ccProjectSlug(cwd), `${sessionId}.jsonl`);
}

// Fire-and-forget store write with carry-forward 1 baked in: upsert can reject
// on lock timeout, and an uncaught rejection in Electron main is fatal-ish noise.
// The reconciler catches up whatever a dropped write missed.
function safeUpsert(input: Parameters<ConversationStore['upsert']>[0]): void {
  store?.upsert(input).catch(() => { /* lock contention — reconciler catches up */ });
}

export function noteTranscriptEvent(claudeSessionId: string, ev: TranscriptEvent): void {
  if (!store) return;
  const ctx = sessions.get(claudeSessionId);
  const upsertNow = () => {
    // Carry-forward 4: clear any pending debounce for this session before the
    // immediate write, so a stale timer can't fire a redundant older upsert 5s
    // later.
    const t = pendingActivity.get(claudeSessionId);
    if (t) { clearTimeout(t); pendingActivity.delete(claudeSessionId); }
    safeUpsert({
      id: claudeSessionId,
      provider: 'claude',
      // Metadata fields are LOCAL TRUTH in the store's merge; omit them (leave
      // undefined) when no cwd is known so we never overwrite a real value with ''.
      projectName: ctx ? path.basename(ctx.cwd) : undefined,
      originalPath: ctx?.cwd,
      // ev.timestamp is a Date.now() ms number stamped by the watcher (NOT the
      // JSONL time), so new Date(...) is safe.
      lastActive: new Date(ev.timestamp).toISOString(),
      device,
      transcriptRef: ctx
        ? `claude/transcripts/${path.basename(ctx.cwd)}/${claudeSessionId}.jsonl`
        : undefined,
    });
  };

  if (ev.type === 'turn-complete') {
    upsertNow();
    if (ctx) {
      const key = path.basename(ctx.cwd);
      try {
        // Mirror the fresh local transcript into the durable space copy so it
        // rides the personal-space sync. Best-effort — the reconciler re-mirrors.
        mirrorIn({
          localJsonlPath: localJsonlPath(ctx.cwd, claudeSessionId),
          spaceTranscriptPath: spaceTranscriptPath(key, claudeSessionId),
        });
      } catch { /* best-effort; the reconciler catches up */ }
      // Prompt push (design §2): conversations move faster than the engine's
      // quiet-window debounce, so nudge a sync now. syncSpace is single-flight —
      // bursts coalesce. Wrapped in Promise.resolve so a sync/throwing stub
      // can't produce an unhandled rejection either.
      Promise.resolve(syncSpacesSyncNow('personal')).catch(() => { /* the poll covers a miss */ });
    }
    return;
  }

  // Chatty events (assistant-text / tool-use / thinking / …) debounce to one
  // activity upsert per quiet window — a turn can emit dozens.
  if (!pendingActivity.has(claudeSessionId)) {
    const t = setTimeout(upsertNow, ACTIVITY_DEBOUNCE_MS);
    t.unref?.();
    pendingActivity.set(claudeSessionId, t);
  }
}

// Carry-forward 5: only the auto-title flow (topic-watcher) calls this. setTitle
// is timestamp-less — it never fabricates activity. No user-rename path exists
// for conversations yet (Plan 2b/2c scope).
export function noteTitleChanged(claudeSessionId: string, title: string): void {
  store?.setTitle('claude', claudeSessionId, title).catch(() => { /* carry-forward 1 */ });
}

export function noteFlagChanged(claudeSessionId: string, flag: string, value: boolean): void {
  store?.setFlag('claude', claudeSessionId, flag, value).catch(() => { /* carry-forward 1 */ });
}

export function noteSessionNote(claudeSessionId: string, note: string): void {
  store?.setNote('claude', claudeSessionId, note).catch(() => { /* carry-forward 1 */ });
}

// resolveLocalProject (originalPath → managed-by-name → saved-by-basename) lives
// in ./resolve-local-project so the Resume Browser can reuse the IDENTICAL logic
// — see buildLocalProjectResolver below and session-browser.ts. The managed/saved
// lookups are HOISTED by callers (review fix 2): on a secondary device where
// originalPath never exists, per-record readdir + JSON reads made the sweep
// O(records × disk-reads) on EVERY remote turn.

/**
 * Build a resolver bound to THIS device's managed projects + saved folders, so
 * a caller (the Resume Browser) resolves a synced record to the SAME local
 * folder the materialize sweep does. Built ONCE per browse — the managed/saved
 * reads are cheap but not per-record. Cross-OS safe: a foreign-OS originalPath
 * that doesn't exist here is skipped in favor of the name/basename fallbacks.
 */
export function buildLocalProjectResolver(): (rec: { projectName: string; originalPath: string }) => string | null {
  const managed = new Map<string, string>(
    (getManagedRoots()?.listProjects() ?? []).map((p) => [p.name, p.path]),
  );
  let saved: Array<{ path: string }> = [];
  try { saved = readFolders(); } catch { /* saved folders unreadable */ }
  return (rec) => resolveLocalProject(rec, managed, saved);
}

async function materializeSweep(): Promise<void> {
  // Capture the store (review fix 3): stop() mid-sweep nulls the module field,
  // and every use below an await would otherwise become a swallowed TypeError.
  const s = store;
  if (!s) return;
  let records;
  try { records = await s.list('claude'); } catch { return; }
  // Hoist the project lookups once per sweep (review fix 2) — see
  // resolveLocalProject's comment for why per-record IO was a real cost.
  const managed = new Map<string, string>(
    (getManagedRoots()?.listProjects() ?? []).map((p) => [p.name, p.path]),
  );
  let saved: Array<{ path: string }> = [];
  try { saved = readFolders(); } catch { /* saved folders unreadable */ }
  for (const rec of records) {
    if (!rec.transcriptRef) continue; // no durable copy to materialize from
    // Review fix 1: NEVER materialize over a LIVE session's transcript. Without
    // leases (Plan 2b), a same-conversation-on-two-devices pull would replace
    // the JSONL Claude Code is actively appending to — Windows EPERM containment
    // is unreliable (libuv opens with FILE_SHARE_DELETE), and on POSIX the
    // rename always succeeds: CC keeps appending to the unlinked inode, the
    // TranscriptWatcher's path-read never grows, chat view freezes, and local
    // turns are lost when the handle closes. Accepted caveat: nothing removes
    // entries from `sessions` on session exit, so an ended session stays
    // guarded until restart — fine for 2a because mirrorIn keeps the space
    // current from the fresher local side; a noteSessionEnded refinement lands
    // with leases in 2b.
    if (sessions.has(rec.id)) continue;
    const local = resolveLocalProject(rec, managed, saved);
    if (!local) continue;
    try {
      materializeOut({
        spaceTranscriptPath: path.join(s.root(), rec.transcriptRef),
        localJsonlPath: localJsonlPath(local, rec.id),
      });
    } catch { /* per-record isolation — one bad copy must not abort the sweep */ }
  }
}

// Bug 2 Part 2 (Plan 2b Task 7): called from the session-exit IPC handler when a
// CLAUDE session ends. Releases the per-session materialize guard `sessions` sets
// (so the record stops being skipped by materializeSweep) AND applies any peer
// version immediately — no app restart needed, which was the Bug-2 symptom. The
// companion lease release lands in Task 8.
export function noteSessionEnded(claudeSessionId: string): void {
  const ctx = sessions.get(claudeSessionId);
  sessions.delete(claudeSessionId); // release the materialize guard FIRST — even if the rest bails
  if (!store) return;
  // The targeted materialize is gated on the local transcript being quiescent
  // (CC may still be flushing) and never full-scans — see materializeOne.
  void materializeOne(claudeSessionId, ctx?.cwd).catch(() => { /* never reject in main */ });
}

// Targeted equivalent of materializeSweep for ONE session: resolve its local
// project, wait for the local transcript to go quiescent, then pull a larger peer
// version over it (grow-only, same as the sweep). Isolated so an ended session
// applies a peer edit without waiting for the 30-min reconcile tick.
//
// Plan 2b Task 9: EXPORTED and renamed from materializeEndedSession because the
// REQUESTER-side takeover flow reuses it — after a holder releases a lease, the
// requester pulls the peer's final turn into the local CC transcript with this.
// For the requester there's no live local session (sessions.has(id) is false and
// the local file is stale/absent), so it quiesces immediately; cwd is undefined
// so it resolves the project via resolveLocalProject.
export async function materializeOne(id: string, cwd?: string): Promise<void> {
  const s = store; if (!s) return;
  let rec; try { rec = await s.get('claude', id); } catch { return; }
  if (!rec?.transcriptRef) return;
  // Resolve the local project. On the common path cwd is known (learned via
  // noteSessionStarted), so only pay for the managed/saved-folder reads on the
  // cwd miss (a session that ended without ever being announced here).
  let local = cwd;
  if (!local) {
    const managed = new Map<string, string>((getManagedRoots()?.listProjects() ?? []).map((p) => [p.name, p.path]));
    let saved: Array<{ path: string }> = [];
    try { saved = readFolders(); } catch { /* saved folders unreadable */ }
    local = resolveLocalProject(rec, managed, saved) ?? undefined;
  }
  if (!local) return;
  const localPath = localJsonlPath(local, id);
  // Quiescence: if it never stabilizes before QUIESCE_MAX_MS, CC is still
  // flushing — SKIP this round (never rename over a transcript CC still has open:
  // POSIX detaches the inode and CC keeps appending to it → chat freeze + lost
  // turns). The reconciler/startup sweep catch up once the local file is quiet.
  if (!(await waitForQuiescence(localPath))) return; // timed out still growing — skip, do NOT materialize
  // Re-opened during the wait — the live guard wins; do NOT touch the transcript
  // CC is now appending to (the sweep's live-session invariant).
  if (sessions.has(id)) return;
  try {
    materializeOut({ spaceTranscriptPath: path.join(s.root(), rec.transcriptRef), localJsonlPath: localPath });
  } catch { /* grow-only copy failed — startup sweep catches up */ }
}

// Poll the local transcript size until it holds steady across one probe interval.
// Returns true if it went quiescent, false on timeout (still growing at
// QUIESCE_MAX_MS). Shared by materializeOne (space->local direction:
// skip on timeout) and flushSessionToSpace (local->space direction: push anyway).
async function waitForQuiescence(localPath: string): Promise<boolean> {
  const started = Date.now();
  let prev = -1;
  while (Date.now() - started < QUIESCE_MAX_MS) {
    let size = 0;
    try { size = fs.statSync(localPath).size; } catch { size = 0; } // absent local is quiescent (size 0 stable)
    if (size === prev) return true;
    prev = size;
    await new Promise((r) => setTimeout(r, QUIESCE_PROBE_MS));
  }
  return false;
}

// Holder-side takeover step 4-5 (Plan 2b Task 8): after the holder interrupts,
// wait for CC to finish flushing the interrupted turn, then push the local
// transcript into the space so the REQUESTER pulls the FINAL turn. mirrorIn
// (local->space) is grow-only and never touches CC's open local file, so pushing
// even on a quiescence TIMEOUT is safe (unlike materializeOne's
// space->local direction, which must skip on timeout to avoid clobbering the file
// CC still has open).
export async function flushSessionToSpace(claudeSessionId: string): Promise<void> {
  const s = store; if (!s) return;
  const ctx = sessions.get(claudeSessionId);
  if (!ctx) return; // no cwd known — can't locate the transcript
  const key = path.basename(ctx.cwd);
  const localPath = localJsonlPath(ctx.cwd, claudeSessionId);
  await waitForQuiescence(localPath); // best-effort wait; push regardless of the result
  try { mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spaceTranscriptPath(key, claudeSessionId) }); }
  catch { /* best-effort; the reconciler re-mirrors */ }
  try { await Promise.resolve(syncSpacesSyncNow('personal')); } catch { /* the poll covers a miss */ }
}

function runReconcile(): void {
  if (!store) return;
  const s = store;
  // Known folders let the reconciler recover the EXACT project name for a CC slug
  // instead of the lossy last-segment truncation, so a bare-`claude` session in a
  // hyphenated folder ('youcoded-dev') gets the same projectKey the live path
  // uses — no orphan duplicate transcript, no cross-device materialize gap. Built
  // fresh per run (one readdir + one JSON read every 30 min — cheap).
  const knownFolders: string[] = [
    ...(getManagedRoots()?.listProjects() ?? []).map((p) => p.path),
  ];
  try { knownFolders.push(...readFolders().map((f) => f.path)); }
  catch { /* saved folders unreadable — managed projects still cover most cases */ }
  reconcile({
    projectsDir, topicsDir, store: s, device, knownFolders,
    // Production mirror closure: the reconciler stays free of transcript-mirror
    // + the Conversations root. Best-effort — a throw here must not abort the scan.
    mirror: (localPath: string, projectKey: string, sessionId: string) => {
      try {
        mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spaceTranscriptPath(projectKey, sessionId) });
      } catch { /* best-effort */ }
    },
  }).catch(() => { /* reconciler failure must never break startup (carry-forward 2) */ });
}
