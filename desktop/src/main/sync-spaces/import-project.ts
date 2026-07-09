// Spec §3 import flows: move an existing on-device folder into
// ~/YouCoded/Projects/<name>/ so it becomes a synced project. This module owns
// the guards, the move itself, and the remap of every store that keys on the
// folder's absolute path. Space/remote initialization stays in service.ts (it
// owns the engine singletons).
import fs from 'fs';
import path from 'path';
import { validateSyncName, isIgnoredPath, MAX_IMPORT_FILE_COUNT } from './guards';
import { canonicalize } from '../../shared/artifacts/canonicalize';

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
function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + '/');
}

/** Count real files under root, skipping DEFAULT_IGNORES (node_modules etc. —
 *  they never sync so they shouldn't disqualify the folder) and never
 *  following symlinks. Stops at limit+1: callers only need "over or not". */
export function countFilesBounded(root: string, limit: number): number {
  let count = 0;
  const walk = (dir: string, rel: string): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // isIgnoredPath matches directory patterns like 'node_modules/' against
        // a path SEGMENT, so pass the bare relative path (no trailing slash) —
        // guards.ts splits on separators and checks each segment.
        if (isIgnoredPath(childRel)) continue;
        if (!walk(path.join(dir, e.name), childRel)) return false;
      } else if (e.isFile()) {
        if (isIgnoredPath(childRel)) continue;
        count++;
        if (count > limit) return false;
      }
    }
    return true;
  };
  walk(root, '');
  return count;
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
