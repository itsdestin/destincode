// importFile — bring a file the user picked in the native dialog INTO a project
// folder, as either a copy or a move. Replaces the old "+ Add file" behavior,
// which only wrote a manualIncludes pin and never touched the disk.
//
// Safety properties this module owns:
//   - destDir must resolve inside projectRoot (symlink-resolved) — reuses
//     authorizeArtifactWrite so the traversal + protected-path policy is the
//     SAME one the editor save path already enforces. Do not re-inline it.
//   - Never silently overwrites: the caller picks replace / keep-both / skip.
//   - Move is copy-then-unlink and NEVER unlinks before the copy is verified.
//     A cross-filesystem move (external drive to home) cannot be a rename, and
//     a half-failed rename must not eat the user's only copy.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authorizeArtifactWrite } from './write-authorization';
import { invalidateDiscoveryCache } from './project-file-discovery';

export type ImportMode = 'move' | 'copy';
export type CollisionMode = 'replace' | 'keep-both' | 'skip';

export type ImportFileResult =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; relPath: string }
  | { ok: false; error: string; detail?: string };

const exists = async (p: string): Promise<boolean> => {
  try { await fs.promises.access(p); return true; } catch { return false; }
};

// "notes.md" colliding twice becomes "notes (2).md" then "notes (3).md".
// Extension is preserved so the file keeps opening in the right viewer.
async function freeName(destDir: string, base: string): Promise<string> {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(path.join(destDir, candidate)))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export async function importFile(args: {
  projectRoot: string;
  sourcePath: string;
  destDir: string;
  mode: ImportMode;
  onCollision: CollisionMode;
}): Promise<ImportFileResult> {
  const { projectRoot, sourcePath, destDir, mode, onCollision } = args;

  // Source must exist before anything else — a missing source is the most
  // common failure and deserves its real code, not a generic message.
  try {
    const st = await fs.promises.stat(sourcePath);
    if (!st.isFile()) return { ok: false, error: 'ENOTFILE', detail: sourcePath };
  } catch (e: any) {
    return { ok: false, error: e.code ?? 'ENOENT', detail: sourcePath };
  }

  let name = path.basename(sourcePath);
  const collided = await exists(path.join(destDir, name));
  if (collided) {
    if (onCollision === 'skip') return { ok: true, skipped: true };
    if (onCollision === 'keep-both') name = await freeName(destDir, name);
    // 'replace' falls through — copyFile overwrites by default.
  }

  const destPath = path.join(destDir, name);

  // Traversal + protected-path policy on the RESOLVED destination. mustStayInRoot
  // is true: an import always lands inside the project by definition.
  //
  // confirmed is NOT passed. The flag means "the caller already showed the
  // protected-path confirm dialog", and the Move/Copy dialog is not that dialog
  // — it asks copy-vs-move, not "you are about to overwrite your .env". So an
  // import into .claude/ or onto a dotenv comes back as needs-confirm and the
  // renderer must surface it as a refusal. Passing confirmed: true here would
  // skip the one gate that makes writing an agent hook or a secrets file a
  // deliberate act.
  const auth = await authorizeArtifactWrite({
    projectRoot, fullPath: destPath, mustStayInRoot: true,
  });
  if (!auth.ok) return { ok: false, error: auth.error, detail: (auth as any).path };

  try {
    await fs.promises.copyFile(sourcePath, destPath);
  } catch (e: any) {
    return { ok: false, error: e.code ?? 'COPY_FAILED', detail: e.message };
  }

  // Verify BEFORE unlinking. A short write (full disk) must not cost the source.
  try {
    const [s, d] = await Promise.all([
      fs.promises.stat(sourcePath), fs.promises.stat(destPath),
    ]);
    if (s.size !== d.size) {
      return { ok: false, error: 'COPY_INCOMPLETE', detail: `${d.size} of ${s.size} bytes` };
    }
  } catch (e: any) {
    return { ok: false, error: e.code ?? 'VERIFY_FAILED', detail: e.message };
  }

  if (mode === 'move') {
    try {
      await fs.promises.unlink(sourcePath);
    } catch (e: any) {
      // The copy succeeded — the file IS in the project. Report the partial
      // outcome truthfully rather than claiming the move failed outright.
      invalidateDiscoveryCache(projectRoot);
      return { ok: false, error: 'MOVE_SOURCE_NOT_REMOVED', detail: e.message };
    }
  }

  // Drop the cached scan so the file appears without waiting for the TTL.
  invalidateDiscoveryCache(projectRoot);
  return { ok: true, skipped: false, relPath: path.relative(projectRoot, destPath) };
}
