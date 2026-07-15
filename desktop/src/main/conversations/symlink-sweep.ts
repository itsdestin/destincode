// One-time cleanup of the legacy sync-service's aggregation artifacts:
// aggregateConversations() symlinked every conversation into the home slug, and
// rewriteProjectSlugs() junctioned foreign-device slug dirs. Deleting those
// creators does NOT remove the ~687 links already on disk — this sweep does.
// lstat (never stat) so we NEVER follow a link; remove ONLY symlinks/junctions.
import fs from 'node:fs';
import path from 'node:path';

export function sweepProjectSymlinks(projectsDir: string): { removed: number; failed: number } {
  let removed = 0, failed = 0;
  let slugs: string[] = [];
  try { slugs = fs.readdirSync(projectsDir); } catch { return { removed, failed }; }
  for (const slug of slugs) {
    const slugPath = path.join(projectsDir, slug);
    try {
      const slugStat = fs.lstatSync(slugPath);
      // A junctioned/symlinked SLUG DIR (rewriteProjectSlugs artifact): remove the link itself.
      if (slugStat.isSymbolicLink()) { removeLink(slugPath); removed++; continue; }
      if (!slugStat.isDirectory()) continue; // stray non-dir at the top level — leave it
      // One level deep only: legacy artifacts are always exactly one level — a
      // whole-slug junction (handled above) or a .jsonl symlink directly inside a
      // slug dir (handled here). No recursion into real subdirs.
      for (const entry of fs.readdirSync(slugPath)) {
        const p = path.join(slugPath, entry);
        try {
          // lstat, so a symlink to a dir reports isSymbolicLink() (not isDirectory).
          if (fs.lstatSync(p).isSymbolicLink()) { removeLink(p); removed++; }
        } catch { failed++; } // per-entry isolation — one EACCES must not abort the sweep
      }
    } catch { failed++; }
  }
  return { removed, failed };
}

// unlink works for file symlinks; dir symlinks/junctions on Windows need rmdir.
// NEVER recursive — recursion through a junction deletes the target's contents.
// The rmdirSync fallback can shadow the original unlink error, but the caller's
// {removed, failed} counts are the only observable output, so that's acceptable.
function removeLink(p: string): void {
  try { fs.unlinkSync(p); }
  catch { fs.rmdirSync(p); }
}
