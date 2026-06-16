// saved-folder-projects — turn the user's SAVED FOLDERS (the same list the
// session-creation folder picker shows, stored in ~/.claude/youcoded-folders.json)
// into the Project View project list.
//
// WHY this is the source of truth: the Project View must reflect the folders the
// user manages inside YouCoded, with NO dependency on Claude Code's
// ~/.claude/projects/<slug> layout. A folder shows up here because the user added
// it to the picker — not because Claude happened to write a tracked artifact in it.
//
// Reconciliation: when a saved folder already has a central-index entry (matched
// by CANONICAL path), reuse that entry so artifact lookups by `id` resolve and the
// real stats come through. A saved folder with no index entry gets a SYNTHETIC
// entry whose `id` is its canonical path — LIST_PROJECT treats an unknown id as a
// folder path, so its artifacts (if any sidecar exists) still resolve.
//
// Pure module (no fs/path/os) — mirrors local-theme-synthesizer so it stays
// unit-testable. All filesystem reads happen in the IPC shell that calls this.
import { CentralIndexProject } from '../../shared/artifacts/types';
import { canonicalize } from '../../shared/artifacts/canonicalize';

export interface SavedFolderInput {
  path: string;
  nickname?: string;
  addedAt?: number;
  exists?: boolean;
}

// Last path segment, separator-agnostic — used when a saved folder has no nickname.
function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

export function buildSavedFolderProjects(
  savedFolders: SavedFolderInput[],
  indexProjects: CentralIndexProject[],
): CentralIndexProject[] {
  const byCanonPath = new Map<string, CentralIndexProject>();
  for (const p of indexProjects) byCanonPath.set(canonicalize(p.path, null), p);

  const seen = new Set<string>();
  const out: CentralIndexProject[] = [];
  for (const f of savedFolders) {
    const canon = canonicalize(f.path, null);
    if (seen.has(canon)) continue; // two saved folders that canonicalize equal
    seen.add(canon);

    const indexed = byCanonPath.get(canon);
    if (indexed) {
      // Reuse the real index entry (id + stats); prefer the user's nickname for
      // display so the hero/switcher show what they named the folder.
      out.push({ ...indexed, name: f.nickname?.trim() || indexed.name });
    } else {
      out.push({
        id: canon,                 // synth id = canonical path (LIST_PROJECT path-fallback)
        name: f.nickname?.trim() || basename(f.path),
        path: canon,
        lastIndexed: '',
        lastSession: null,
        contentTypes: [],
        stats: { artifactCount: 0 },
      });
    }
  }
  return out;
}
