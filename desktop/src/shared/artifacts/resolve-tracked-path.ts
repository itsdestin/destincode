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

  // 2. Cross-device remap: the transcript recorded ANOTHER device's absolute path.
  //    The project folder name is byte-identical across devices (it IS the sync
  //    identity), so find it as a path segment and rebuild the relative tail
  //    against this device's root. Case-insensitive match tolerates Windows
  //    drive/case drift; the identical folder name makes a false hit unlikely,
  //    and checkExistence catches any that slip through (they read "deleted",
  //    same as today — not worse).
  const rootBase = fwdRoot.split('/').pop() || '';
  if (rootBase) {
    const segs = fwdPath.split('/');
    const idx = segs.findIndex((s) => s.toLowerCase() === rootBase.toLowerCase());
    if (idx >= 0 && idx < segs.length - 1) {
      return { kind: 'internal', path: segs.slice(idx + 1).join('/'), absolutePath: null };
    }
  }

  // 3. Genuinely external — store the absolute path canonical, basename for display.
  const basename = fwdPath.split('/').pop() || fwdPath;
  return { kind: 'external', path: basename, absolutePath: fwdPath };
}
