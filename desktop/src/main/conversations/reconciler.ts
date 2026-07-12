// Catch-up scan (design §1): sessions run OUTSIDE the app (bare `claude` in a
// terminal) never fire the live transcript-event path, so on startup (and a
// slow periodic tick) we walk ~/.claude/projects and upsert records for what
// we find. The live path remains authoritative — the upsert merge keeps the
// newest data, so re-scanning is always safe.
import fs from 'node:fs';
import path from 'node:path';
import { readSessionTranscriptMeta } from '../session-browser';
import { ccProjectSlug } from '../project-conversations';
import type { ConversationStore } from './conversation-store';
import type { ConversationRecord } from './store-core';

// Same UUID gate as the legacy index (sync-service.ts SESSION_UUID_RE — COPIED,
// not imported: sync-service is legacy/untouchable). The phantom-id lesson from
// the Resume Browser incident: never create records from malformed ids.
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_TRANSCRIPT_BYTES = 500; // junk threshold, same as listPastSessions

export interface ReconcileOpts {
  projectsDir: string;   // ~/.claude/projects
  topicsDir: string;     // ~/.claude/topics
  store: ConversationStore;
  device: string;
  // Injected so tests don't need a real space; production passes a closure over
  // transcript-mirror + the Conversations root. Best-effort — a throw here must
  // not abort the scan (see safeMirror).
  mirror: (localJsonlPath: string, projectKey: string, sessionId: string) => void;
  // Absolute paths of folders this device knows about (managed projects + saved
  // folders). Used to recover the EXACT folder name for a CC slug instead of the
  // lossy last-segment truncation — see resolveProjectName.
  knownFolders?: string[];
}

// Build a slug → exact-basename lookup from the device's known folders. The CC
// slug encodes the whole cwd with separators flattened, so the last segment
// TRUNCATES hyphenated names ('youcoded-dev' slug → last segment 'dev'). But if
// this device actually has that folder, ccProjectSlug(folder) reproduces CC's
// on-disk slug exactly, letting us recover the true basename. WHY it matters:
// the live/service path keys transcripts by basename(cwd); a mismatched
// reconciler key produces an ORPHAN duplicate space transcript and a
// cross-device materialize gap (the record's projectKey never matches the peer's
// managed project). Keys are lowercased so Windows case drift between a saved
// folder path and CC's cwd can't miss the match.
function buildSlugToName(knownFolders: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const folder of knownFolders ?? []) {
    try { m.set(ccProjectSlug(folder).toLowerCase(), path.basename(folder)); }
    catch { /* unslugifiable path — skip */ }
  }
  return m;
}

// Exact folder name when this device knows the folder; else an existing record's
// name; else the lossy truncation (corrected by the live path next in-app run).
function resolveProjectName(
  existing: ConversationRecord | null,
  slug: string,
  slugToName: Map<string, string>,
): string {
  return existing?.projectName || slugToName.get(slug.toLowerCase()) || projectNameFromSlug(slug);
}

// LAST-RESORT fallback used only when the folder is NOT among this device's
// known folders (see buildSlugToName/resolveProjectName, which recover the exact
// basename first). A CC slug is the cwd with separators flattened to '-'
// (cwdToProjectSlug); the original path is not recoverable from the slug alone,
// so this takes the LAST slug segment — a TRUNCATION for hyphenated names
// ('...-youcoded-dev' → 'dev'). Acceptable as a fallback because it's internally
// consistent (transcriptRef and the mirror key use the same string) and the live
// path corrects it the next time the session runs in the app.
function projectNameFromSlug(slug: string): string {
  const parts = slug.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : slug;
}

// Topic-file title wins over the derived fallback (matches session-browser
// precedence). Placeholders ('New Session' / 'Untitled') are treated as absent
// so the derived fallback still applies.
function readTopicTitle(topicsDir: string, sessionId: string): string {
  try {
    const t = fs.readFileSync(path.join(topicsDir, `topic-${sessionId}`), 'utf8').trim();
    if (t && t !== 'New Session' && t !== 'Untitled') return t;
  } catch { /* no topic file */ }
  return '';
}

// Mirror is best-effort housekeeping — a throw (space dir unwritable, disk full)
// must never kill the catch-up scan. Isolated so the loop continues.
function safeMirror(opts: ReconcileOpts, localJsonlPath: string, projectKey: string, sessionId: string): void {
  try { opts.mirror(localJsonlPath, projectKey, sessionId); }
  catch { /* mirror is best-effort; the record write already landed */ }
}

// Returns the number of records that were actually upserted (not counting
// files that were skipped, already-fresh, or failed).
export async function reconcile(opts: ReconcileOpts): Promise<number> {
  let upserts = 0;
  let slugs: string[] = [];
  // No projects dir → nothing to reconcile.
  try { slugs = fs.readdirSync(opts.projectsDir); } catch { return 0; }

  // Recover exact folder names for this device's known folders (see the helper).
  const slugToName = buildSlugToName(opts.knownFolders);

  // PERF (review fix): preload ALL existing records in ONE list() pass instead
  // of store.get() per transcript. get() runs heal(), which readdirs the whole
  // provider dir — per-file gets made the scan O(n²) in dirents (measured 2.8s
  // steady-state at 600 records, every startup + 30-min tick). list() heals
  // once in a single pass. On list failure the map stays empty and the scan
  // degrades to create-everything upserts, which the store's merge absorbs
  // safely (newest data wins).
  const existingById = new Map<string, ConversationRecord>();
  try {
    for (const r of await opts.store.list('claude')) existingById.set(r.id, r);
  } catch { /* degraded: treat everything as new; upsert merges safely */ }

  // COLLECT PASS — map each session id to its MOST-SPECIFIC (longest) slug, and
  // cache the per-slug file lists so the process pass doesn't re-readdir.
  // WHY: Claude Code writes a session's transcript into the HOME-dir project too,
  // not only its real cwd project — verified on a real machine: the same id lives
  // under BOTH `C--Users-desti` and its actual cwd slug `C--Users-desti-<proj>`.
  // Because readdir hands back the shorter home slug first (it's a prefix), a
  // naive first-seen scan tagged EVERY duplicated conversation with the home
  // basename ('desti') and mirrored them all into one bucket. The longest slug is
  // the deepest/real cwd, so it wins — the exact heuristic session-browser.ts
  // uses to dedup (`projectSlug.length > existing.projectSlug.length`). A session
  // that appears ONLY under the home slug is a genuine home session and keeps it.
  const authoritativeSlug = new Map<string, string>(); // sessionId → longest slug
  const slugFiles = new Map<string, string[]>();
  for (const slug of slugs) {
    const dir = path.join(opts.projectsDir, slug);
    let files: string[] = [];
    // A non-directory entry (or an unreadable dir) just yields no files.
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    slugFiles.set(slug, files);
    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      if (!SESSION_UUID_RE.test(sessionId)) continue;
      const prev = authoritativeSlug.get(sessionId);
      if (!prev || slug.length > prev.length) authoritativeSlug.set(sessionId, slug);
    }
  }

  // PROCESS PASS — each id is handled once, under its authoritative slug only.
  for (const slug of slugs) {
    const dir = path.join(opts.projectsDir, slug);
    const files = slugFiles.get(slug) ?? [];
    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      // Malformed ids never become records (phantom-id guard).
      if (!SESSION_UUID_RE.test(sessionId)) continue;
      // Skip a less-specific duplicate — a longer slug owns this id (see above).
      if (authoritativeSlug.get(sessionId) !== slug) continue;
      const jsonlPath = path.join(dir, file);
      // Per-file isolation (review carry-forward): a store lock-timeout throw,
      // an unreadable transcript, or a meta-read error on ONE file must never
      // abort the whole catch-up scan — skip the file, keep scanning.
      try {
        let size = 0;
        try { size = fs.statSync(jsonlPath).size; } catch { continue; }
        if (size < MIN_TRANSCRIPT_BYTES) continue;

        const existing = existingById.get(sessionId) ?? null;
        // Gate read: tail timestamp only (wantTitle=false). Computing the title
        // here wasted a 256KB head read on every fresh-but-untitled record each
        // scan — the title is only needed on the upsert branch below.
        const gateMeta = await readSessionTranscriptMeta(jsonlPath, false);
        // lastActive from the transcript's own content timestamp — mtimes lie
        // after any sync/restore (the 627-file rebump incident).
        const lastActive = gateMeta.lastTimestampMs ? new Date(gateMeta.lastTimestampMs).toISOString() : null;

        if (existing && lastActive && Date.parse(existing.lastActive) >= Date.parse(lastActive)) {
          // Record already as fresh as the file — leave it, but still mirror
          // (cheap size check inside mirror makes a no-op copy when unchanged).
          safeMirror(opts, jsonlPath, resolveProjectName(existing, slug, slugToName), sessionId);
          continue;
        }
        // Corrupt-transcript guard (review fix): a >500-byte file with NO
        // parseable tail timestamp is corrupt (the UUID/junk gates set the
        // precedent for refusing bad inputs). Creating a record would stamp
        // EPOCH lastActive and re-upsert on EVERY scan forever (the freshness
        // gate never passes for EPOCH), and an EXISTING record must not be
        // touched on the say-so of a corrupt file. Skip entirely — no record,
        // and no mirroring of corrupt bytes into the durable space copy.
        if (!lastActive) continue;

        const projectName = resolveProjectName(existing, slug, slugToName);
        // Title resolution only when needed: topic file first (cheap), then the
        // derived first-user-message title via a second meta read with
        // wantTitle=true. The double tail-read on this branch is acceptable —
        // it only happens for records that actually upsert.
        let title = readTopicTitle(opts.topicsDir, sessionId);
        if (!title && !existing?.title) {
          title = (await readSessionTranscriptMeta(jsonlPath, true)).fallbackTitle || '';
        }
        const upserted = await opts.store.upsert({
          id: sessionId,
          provider: 'claude',
          projectName,
          title: title || undefined,
          lastActive, // non-null here — the corrupt-guard above filtered null
          device: opts.device,
          // transcriptRef uses projectName (the portable projectKey), NOT the CC slug.
          transcriptRef: `claude/transcripts/${projectName}/${sessionId}.jsonl`,
        });
        // Keep the preload map current: the SAME session id can appear under a
        // second slug dir later in the scan (session-browser dedups by longest
        // slug for the same reason) — the second sighting must see this upsert,
        // not the stale preload.
        existingById.set(sessionId, upserted);
        // Count only AFTER the upsert lands, and BEFORE the best-effort mirror,
        // so a mirror throw never un-counts a successful record write.
        upserts++;
        safeMirror(opts, jsonlPath, projectName, sessionId);
      } catch {
        // One bad file skipped — the scan continues.
      }
    }
  }
  return upserts;
}
