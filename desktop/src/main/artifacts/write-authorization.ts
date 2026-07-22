// Resolve-and-authorize for the artifacts:get/save handlers — the enforcement
// half of the D5 boundary (the policy itself is shared/artifacts/
// editable-path-policy.ts). Extracted from ipc-handlers so the security-
// critical behavior — symlink resolution, in-root enforcement on the RESOLVED
// path, tier refusal, concurrency token — is unit-testable against a real
// filesystem (see tests/artifacts/write-authorization.test.ts).
//
// Why realpath everywhere: canonicalize() is pure string work and
// readFile/writeFile follow symlinks, so a link inside the project root (a
// notes.md → ~/.ssh/config) would dodge both the traversal guard and the
// deny-list if we checked the unresolved path. realpath also normalizes
// Windows on-disk casing, so `.ENV` resolves to the real `.env` before the
// policy match.
import fs from 'fs';
import path from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { editTier, protectedReadPath } from '../../shared/artifacts/editable-path-policy';

export type ReadResolution =
  | { ok: true; realPath: string }
  | { ok: false; error: 'artifact-not-found' | 'protected-path' }
  | { ok: false; orphan: true };

export type WriteResolution =
  | { ok: true; realPath: string }
  | { ok: false; error: 'artifact-not-found' }
  | { ok: false; error: 'protected-path' | 'needs-confirm'; path: string }
  | { ok: false; error: 'conflict' };

async function inRealRoot(projectRoot: string, realPath: string): Promise<boolean> {
  const realRoot = await fs.promises.realpath(path.resolve(projectRoot)).catch(() => null);
  if (!realRoot) return false;
  return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
}

/**
 * Resolve a GET target. mustStayInRoot applies to discovered files and
 * tracked-INTERNAL artifacts (whose sidecar `path` was never traversal-checked
 * before, spec §12.1); tracked externals are legitimately out-of-root and rely
 * on the protected-read check alone.
 */
export async function authorizeArtifactRead(
  projectRoot: string,
  fullPath: string,
  mustStayInRoot: boolean
): Promise<ReadResolution> {
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(fullPath);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return { ok: false, orphan: true };
  }
  if (mustStayInRoot && !(await inRealRoot(projectRoot, realPath))) {
    return { ok: false, error: 'artifact-not-found' };
  }
  // Sensitive read deny — the set read-binary already refuses, MINUS dotenv:
  // .env stays viewable because it is confirm-tier EDITABLE (the pane is the
  // human escape hatch; the agent's tools stay hard-denied). See D5.
  if (protectedReadPath(canonicalize(realPath, null))) {
    return { ok: false, error: 'protected-path' };
  }
  return { ok: true, realPath };
}

/**
 * Resolve and authorize a SAVE target. Runs, in order: symlink resolution
 * (falling back to parent-resolution when the file was deleted mid-edit —
 * saving then legitimately recreates it), in-root enforcement on the resolved
 * path, the D5 tier policy, and the optimistic-concurrency token.
 */
export async function authorizeArtifactWrite(args: {
  projectRoot: string;
  fullPath: string;
  mustStayInRoot: boolean;
  baseMtimeMs?: number;
  confirmed?: boolean;
}): Promise<WriteResolution> {
  const { projectRoot, fullPath, mustStayInRoot, baseMtimeMs, confirmed } = args;

  let realPath: string;
  try {
    realPath = await fs.promises.realpath(fullPath);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    try {
      realPath = path.join(await fs.promises.realpath(path.dirname(fullPath)), path.basename(fullPath));
    } catch {
      return { ok: false, error: 'artifact-not-found' };
    }
  }
  if (mustStayInRoot && !(await inRealRoot(projectRoot, realPath))) {
    return { ok: false, error: 'artifact-not-found' };
  }

  // D5 policy — 'denied' is the security boundary; 'needs-confirm' requires
  // the caller to have shown the confirm dialog and say so (main refuses
  // otherwise, so a caller that skipped the dialog cannot skip the policy).
  const canon = canonicalize(realPath, null);
  const tier = editTier(canon);
  if (tier === 'denied') return { ok: false, error: 'protected-path', path: canon };
  if (tier === 'needs-confirm' && !confirmed) return { ok: false, error: 'needs-confirm', path: canon };

  // Optimistic concurrency (spec §12.9): token mismatch means someone — the
  // agent, another window, an external tool — wrote since this draft's base
  // was read. ENOENT falls through: the file was deleted and saving keeps the
  // user's draft.
  if (typeof baseMtimeMs === 'number') {
    try {
      const cur = await fs.promises.stat(realPath);
      if (cur.mtimeMs !== baseMtimeMs) return { ok: false, error: 'conflict' };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { ok: true, realPath };
}
