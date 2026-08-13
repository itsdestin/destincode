// resolve-tracked-path — decide whether a transcript-recorded file path is an
// INTERNAL artifact (inside the current project) or an EXTERNAL one, and produce
// the path fields the artifact sidecar stores.
//
// WHY this exists (cross-device sync, 2026-07-13 dogfood): Claude Code records
// ABSOLUTE paths in the transcript (e.g. `C:\Users\desti\YouCoded\Projects\
// cookinonlowheat\recipe.md`). When a conversation is RESUMED on another device,
// the project folder is at a DIFFERENT absolute location (`/home/desti/YouCoded/
// Projects/cookinonlowheat/recipe.md` on Linux, or a different Windows home).
// A naive "does the recorded path start with the local project root" test fails,
// so the file gets mis-filed as EXTERNAL pointing at the other machine's path —
// and checkExistence then marks it "deleted" even though the synced file is
// sitting right there under the local root. This helper remaps such paths back
// to internal by locating the project folder name (identical across devices) as
// a path segment and rebuilding the relative tail against THIS device's root.
//
// Pure (no fs/path/os) so it's unit-testable and importable by the renderer
// tracker. checkExistence remains the safety net: if a remap is wrong the file
// simply still reads "deleted" (never worse than before).

export interface TrackedPathResolution {
  kind: 'internal' | 'external';
  /** Internal: forward-slash relative path under the project root ('' = the root
   *  itself). External: the basename, used only for display. */
  path: string;
  /** External only: the recorded absolute path (forward-slash). null for internal. */
  absolutePath: string | null;
}

export function resolveTrackedPath(recordedPath: string, projectRoot: string): TrackedPathResolution {
  const fwdPath = recordedPath.replace(/\\/g, '/');
  const fwdRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normPath = fwdPath.toLowerCase();
  const normRoot = fwdRoot.toLowerCase();

  // 1. Same-device: the recorded path already lives under the local project root.
  if (normPath === normRoot) return { kind: 'internal', path: '', absolutePath: null };
  if (normRoot && normPath.startsWith(normRoot + '/')) {
    return { kind: 'internal', path: fwdPath.slice(fwdRoot.length + 1), absolutePath: null };
  }

  // 2. Cross-device remap: the transcript recorded ANOTHER device's absolute
  //    path. The project folder name is byte-identical across devices (it IS the
  //    sync identity), so find it as a path segment and rebuild the relative
  //    tail against this device's root.
  //
  //    GATED on a cross-OS signal (Windows drive path vs POSIX). WHY: a
  //    same-OS external file whose path merely CONTAINS the project folder name
  //    as a segment (e.g. project "docs", external `/home/x/other/docs/readme.md`)
  //    must NOT be reclassified as internal — that turns a valid, openable
  //    external file into a phantom "deleted" artifact, which is WORSE than
  //    leaving it external. On-disk existence is the only fully-reliable
  //    same-OS distinguisher, and this pure helper can't touch disk. The cross-OS
  //    case (the real cross-device pair here: Windows GalaxyBook ↔ Linux) is
  //    unambiguous and safe. Known limitation: two devices on the SAME OS with
  //    different home dirs aren't remapped — those files read "deleted"
  //    (unchanged from before this fix); covering that needs an on-disk check
  //    (follow-up). Same-username same-OS devices have identical paths → step 1.
  const recordedIsWindows = /^[a-zA-Z]:[\\/]/.test(recordedPath);
  const rootIsWindows = /^[a-zA-Z]:[\\/]/.test(projectRoot);
  // Fix: step 2 remaps ANOTHER DEVICE'S ABSOLUTE PATH. A relative path has no
  // OS-ness of its own, so the `recordedIsWindows !== rootIsWindows` gate below
  // fired on every relative path under a Windows root and, if the path happened
  // to contain the project folder name as a segment, silently returned the WRONG
  // file ('proj/notes.md' → 'notes.md', when the harness meant proj/proj/notes.md).
  const recordedIsAbsolute = recordedIsWindows || fwdPath.startsWith('/');
  if (recordedIsAbsolute && recordedIsWindows !== rootIsWindows) {
    const rootBase = fwdRoot.split('/').pop() || '';
    if (rootBase) {
      const segs = fwdPath.split('/');
      // Case-insensitive tolerates Windows drive/case drift across the OS boundary.
      const idx = segs.findIndex((s) => s.toLowerCase() === rootBase.toLowerCase());
      if (idx >= 0 && idx < segs.length - 1) {
        return { kind: 'internal', path: segs.slice(idx + 1).join('/'), absolutePath: null };
      }
    }
  }

  // 3. Relative recorded path → internal. The native harness tools accept a
  //    relative file_path and resolve it with path.resolve(ctx.cwd, p) themselves
  //    (main/harness/tools/guards.ts), but the transcript event we consume
  //    carries the RAW arg. The tracker passes session.cwd as projectRoot
  //    (App.tsx:1507) — the SAME value the harness resolved against — so a
  //    relative path here is in-project by identity, not by inference.
  //
  //    WHY internal rather than absolutising into an external: internal records
  //    survive cross-device sync (that is the entire point of step 2). An
  //    external carrying a machine-specific absolute path breaks again the next
  //    time the conversation is resumed on another device.
  //
  //    MUST run AFTER step 2. 'C:/Users/...' is not absolute by POSIX rules, so
  //    on Linux it reaches here; the drive-letter test below catches the case
  //    where step 2 ran but found no project-root segment to remap. Without it
  //    we would produce join(root, 'C:/Users/...') — worse than leaving the
  //    record external.
  if (!recordedIsAbsolute && fwdPath !== '') {
    // A '..' segment escapes the root once joined, manufacturing a phantom
    // internal artifact. Leave those external — authorizeArtifactRead's in-root
    // check would reject them anyway, but as an unexplained "not found".
    if (!fwdPath.split('/').includes('..')) {
      return { kind: 'internal', path: fwdPath.replace(/^\.\//, ''), absolutePath: null };
    }
  }

  // 4. Genuinely external — store the absolute path canonical, basename for display.
  const basename = fwdPath.split('/').pop() || fwdPath;
  return { kind: 'external', path: basename, absolutePath: fwdPath };
}
