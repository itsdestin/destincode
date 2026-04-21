import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Legacy Cleanup — youcoded-core toolkit deprecation.
 *
 * Prior to the 2026-04 deprecation, the app cloned the youcoded-core repo
 * to ~/.claude/plugins/youcoded-core/ via prerequisite-installer.cloneToolkit()
 * and relied on the HookReconciler to register its hooks into settings.json.
 *
 * Post-deprecation, the one surviving hook (write-guard.sh) ships bundled
 * inside the app. Users who upgraded from a prior version still have the
 * legacy clone on disk with its stale hook entries pointing at it. This
 * module removes that directory on app launch. The subsequent reconcileHooks()
 * call's pruneDeadPluginHooks() pass then strips the orphaned settings.json
 * entries automatically.
 *
 * Non-fatal on error (permission issues, mount issues, etc.) — the caller
 * logs but never throws. Worst case, the legacy dir sits there and its old
 * hooks keep firing until the next successful cleanup attempt.
 */

export interface LegacyCleanupResult {
  removed: boolean;
  path?: string;
  error?: string;
}

export function cleanupLegacyYoucodedCore(): LegacyCleanupResult {
  const legacyPath = path.join(os.homedir(), '.claude', 'plugins', 'youcoded-core');

  if (!fs.existsSync(legacyPath)) {
    return { removed: false };
  }

  try {
    fs.rmSync(legacyPath, { recursive: true, force: true });
    return { removed: true, path: legacyPath };
  } catch (e) {
    return { removed: false, path: legacyPath, error: String(e) };
  }
}
