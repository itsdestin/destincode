// Spec §3 import flows: move an existing on-device folder into
// ~/YouCoded/Projects/<name>/ so it becomes a synced project. This module owns
// the guards, the move itself, and the remap of every store that keys on the
// folder's absolute path. Space/remote initialization stays in service.ts (it
// owns the engine singletons).
//
// NOTE: checkImport() is a UX PRE-FLIGHT, not an authoritative gate. It runs
// before the move to give a friendly refusal, but the world can change between
// the check and the move (TOCTOU). The move path (Task 4) must independently
// tolerate the source having vanished, the destination name having been claimed,
// or a session having opened in the folder — it cannot assume checkImport's
// answer still holds when it runs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateSyncName, isIgnoredPath, MAX_IMPORT_FILE_COUNT } from './guards';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { updateFolderPath } from '../saved-folders';
import { remapProjectPath } from '../artifacts/central-index';
import { readSidecar, writeSidecar } from '../artifacts/artifact-store';
import { ccProjectSlug } from '../project-conversations';
import type { ManualInclude } from '../../shared/artifacts/types';

export interface ImportCheckOpts {
  sourcePath: string;
  name: string;
  projectsRoot: string;
  youcodedRoot: string;
  /** cwds of live (non-destroyed) sessions — a folder in use must not move */
  liveCwds: string[];
}

// Canonical prefix containment. canonicalize() yields forward slashes + a
// lowercased drive, so string prefix is safe here. (Byte-case differences in
// the REST of a Windows path aren't normalized — acceptable: every caller
// feeds paths from the same pickers/stores, not hand-typed variants.)
// NOTE: the isUnder(ycCanon, srcCanon) check in checkImport is a SAFETY guard
// (it prevents moving a folder that contains ~/YouCoded into itself), not just
// a UX nicety — so it too relies on pickers/stores yielding consistently-cased
// paths. A caller that fed a differently-cased variant could slip past it.
function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + '/');
}

// Depth + wall-clock caps mirror the sibling bounded walk in
// artifacts/project-file-discovery.ts (which uses files/dirs/depth caps + a
// time budget). The §18 guardrail must never itself hang the Electron main
// thread while probing a folder the user picked.
const MAX_DEPTH = 100;         // 100-deep nesting = pathological or a junction cycle
const WALK_BUDGET_MS = 2000;   // hard wall-clock cap regardless of tree shape

/** Count real files under root, skipping DEFAULT_IGNORES (node_modules etc. —
 *  they never sync so they shouldn't disqualify the folder) and never
 *  following symlinks. Stops at limit+1: callers only need "over or not".
 *
 *  Bounded THREE ways so it can never hang the main process: file count, plus
 *  recursion depth (MAX_DEPTH) and wall-clock time (WALK_BUDGET_MS). WHY the
 *  depth + time caps are load-bearing, not belt-and-suspenders: e.isSymbolicLink()
 *  does NOT detect NTFS junctions — a junction reports isDirectory() === true —
 *  so a junction CYCLE that contains no files would recurse forever (the
 *  file-count limit never trips because it never finds a file to count). On
 *  either cap we return the over-limit signal (limit + 1), NOT the partial
 *  count: a 100-deep tree, or a walk we couldn't finish in 2s, is either
 *  pathological or a cycle, and the honest answer is "too big/weird to
 *  live-sync" — treating it as "fine, N files" would let a monster tree (or an
 *  endless junction loop) through the guardrail. */
export function countFilesBounded(root: string, limit: number): number {
  let count = 0;
  let over = false;
  const deadline = Date.now() + WALK_BUDGET_MS;
  const walk = (dir: string, rel: string, depth: number): boolean => {
    // Depth/time exhaustion => treat the whole walk as over-limit (see fn doc).
    if (depth > MAX_DEPTH || Date.now() > deadline) { over = true; return false; }
    let entries: fs.Dirent[];
    // An unreadable directory yields no files here. If the ROOT itself is
    // unreadable, the count is 0 and the import proceeds past this guard — it
    // then fails at MOVE time with the OS error instead. Accepted trade-off:
    // the pre-flight isn't authoritative (see the module header TOCTOU note).
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // isIgnoredPath matches directory patterns like 'node_modules/' against
        // a path SEGMENT, so pass the bare relative path (no trailing slash) —
        // guards.ts splits on separators and checks each segment.
        if (isIgnoredPath(childRel)) continue;
        if (!walk(path.join(dir, e.name), childRel, depth + 1)) return false;
      } else if (e.isFile()) {
        if (isIgnoredPath(childRel)) continue;
        count++;
        if (count > limit) return false;
      }
    }
    return true;
  };
  walk(root, '', 0);
  return over ? limit + 1 : count;
}

/** Every reason an import must be refused, checked BEFORE anything moves.
 *  Returns a user-facing message, or null when the import may proceed. */
export function checkImport(opts: ImportCheckOpts): string | null {
  const { sourcePath, name, projectsRoot, youcodedRoot, liveCwds } = opts;

  let st: fs.Stats;
  try { st = fs.statSync(sourcePath); } catch { return 'That folder no longer exists'; }
  if (!st.isDirectory()) return 'That path is a file, not a folder';

  const nameErr = validateSyncName(name);
  if (nameErr) return nameErr;

  const srcCanon = canonicalize(sourcePath, null);
  const ycCanon = canonicalize(youcodedRoot, null);
  // Moving a folder that's already inside ~/YouCoded is a no-op at best; moving
  // one that CONTAINS ~/YouCoded would recursively move the destination into
  // itself. Both are refused up front.
  if (isUnder(srcCanon, ycCanon)) return 'This folder is already inside your YouCoded folder';
  if (isUnder(ycCanon, srcCanon)) return "This folder contains your YouCoded folder, so it can't be moved inside it";

  if (fs.existsSync(path.join(projectsRoot, name))) return 'A project with that name already exists';

  // A live session with its cwd inside the source would break mid-move (its
  // working dir vanishes). Refuse and let the user close it first.
  for (const cwd of liveCwds) {
    if (isUnder(canonicalize(cwd, null), srcCanon)) {
      return 'A session is currently open in this folder — close it first, then try again';
    }
  }

  const count = countFilesBounded(sourcePath, MAX_IMPORT_FILE_COUNT);
  if (count > MAX_IMPORT_FILE_COUNT) {
    return `This folder has too many files to live-sync (more than ${MAX_IMPORT_FILE_COUNT.toLocaleString()}). Move what you need into a smaller folder and import that instead.`;
  }

  return null;
}

export type ImportResult =
  | { ok: true; path: string; warnings: string[] }
  | { ok: false; error: string };

export interface ImportOpts extends ImportCheckOpts {
  /** Injectable for tests; defaults to ~/.claude */
  claudeDir?: string;
}

/** Move src → dest. rename when possible; EXDEV (another drive) falls back to
 *  copy-then-delete — still MOVE semantics per spec §3 (a surviving copy at
 *  the old path silently forks the user's work), so a failed source delete is
 *  surfaced as a warning, never ignored. Returns warnings; throws with a
 *  user-facing message on a blocked move (Windows EBUSY/EPERM when another
 *  process holds the folder). */
function moveFolder(src: string, dest: string): string[] {
  try {
    fs.renameSync(src, dest);
    return [];
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      fs.cpSync(src, dest, { recursive: true });
      try {
        fs.rmSync(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        return [];
      } catch {
        return [`The folder was copied to its new home, but the original at ${src} could not be fully removed — delete it manually so you don't keep editing the old copy.`];
      }
    }
    if (e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES') {
      throw new Error('Another program is using this folder (an open terminal, editor, or file). Close it and try again.');
    }
    throw e;
  }
}

/** The sidecar rides inside the folder, so after the move it's already at the
 *  new root — but manualIncludes/manualExcludes hold canonical ABSOLUTE paths
 *  (PITFALLS → Artifact Viewer), which still point at the old location.
 *  Rewrite the old-root prefix. */
async function remapSidecarManualPaths(newRoot: string, oldRoot: string): Promise<void> {
  const cur = await readSidecar(newRoot);
  if (cur === null || 'corrupted' in cur) return;
  const oldCanon = canonicalize(oldRoot, null);
  const newCanon = canonicalize(newRoot, null);
  const remapStr = (p: string) => (isUnder(p, oldCanon) ? newCanon + p.slice(oldCanon.length) : p);
  // manualExcludes is string[]; manualIncludes is ManualInclude[] ({path,…}).
  // Older synced sidecars may still carry bare strings in either list, so the
  // include remapper handles both shapes and preserves whichever it got.
  const remapInclude = (inc: ManualInclude): ManualInclude =>
    typeof inc === 'string' ? (remapStr(inc) as any) : { ...inc, path: remapStr(inc.path) };
  const nextIncludes = cur.manualIncludes.map(remapInclude);
  const nextExcludes = cur.manualExcludes.map(remapStr);
  if (JSON.stringify(nextIncludes) === JSON.stringify(cur.manualIncludes) &&
      JSON.stringify(nextExcludes) === JSON.stringify(cur.manualExcludes)) return;
  const expected = cur.updatedAt;
  cur.manualIncludes = nextIncludes;
  cur.manualExcludes = nextExcludes;
  cur.updatedAt = new Date().toISOString();
  await writeSidecar(newRoot, expected, cur);
}

/** CC's transcript dirs are keyed by a slug DERIVED from the cwd
 *  (~/.claude/projects/<slug>/), not stored — so a move silently orphans every
 *  past conversation unless the dir is renamed to the new path's slug. When
 *  the new slug dir already exists (rare), merge file-by-file, never clobber. */
function remapTranscriptDir(oldPath: string, newPath: string, claudeDir: string): void {
  const projectsDir = path.join(claudeDir, 'projects');
  const oldDir = path.join(projectsDir, ccProjectSlug(oldPath));
  const newDir = path.join(projectsDir, ccProjectSlug(newPath));
  if (!fs.existsSync(oldDir)) return; // no conversations for this folder — nothing to remap
  if (!fs.existsSync(newDir)) {
    fs.renameSync(oldDir, newDir);
    return;
  }
  for (const entry of fs.readdirSync(oldDir)) {
    const from = path.join(oldDir, entry);
    const to = path.join(newDir, entry);
    if (!fs.existsSync(to)) fs.renameSync(from, to);
  }
  try { fs.rmdirSync(oldDir); } catch { /* leftovers (all-duplicate names) — harmless */ }
}

/** Guards → move → best-effort remaps. Remap failures become warnings, not
 *  errors: the folder has already moved, and each store degrades gracefully
 *  (spec §3) — e.g. a missed index remap only means artifact history restarts. */
export async function importProjectFolder(opts: ImportOpts): Promise<ImportResult> {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
  const err = checkImport(opts);
  if (err) return { ok: false, error: err };

  const dest = path.join(opts.projectsRoot, opts.name);
  let warnings: string[];
  try {
    warnings = moveFolder(opts.sourcePath, dest);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  const foldersFile = path.join(claudeDir, 'youcoded-folders.json');
  try { updateFolderPath(opts.sourcePath, dest, foldersFile); }
  catch { warnings.push('The saved-folders list could not be updated — remove the old entry from the picker manually.'); }

  try { await remapProjectPath(claudeDir, canonicalize(opts.sourcePath, null), canonicalize(dest, null), opts.name); }
  catch { warnings.push('The artifact index could not be updated — artifact history may restart for this project.'); }

  try { await remapSidecarManualPaths(dest, opts.sourcePath); }
  catch { warnings.push('Manually added files in the artifact drawer may need re-adding.'); }

  try { remapTranscriptDir(opts.sourcePath, dest, claudeDir); }
  catch { warnings.push('Past conversations could not be re-linked to the new location.'); }

  return { ok: true, path: dest, warnings };
}
