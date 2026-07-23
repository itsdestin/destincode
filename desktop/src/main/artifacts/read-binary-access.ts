// Pure access-control logic for the artifacts:read-binary IPC. The handler
// returns raw file bytes to the renderer — and on remote-access setups that IPC
// is reachable over the WebSocket from a remote browser. Every other artifact
// IPC on this branch is traversal-guarded; this module gives read-binary the
// same treatment. Pure (no fs/path imports) so it stays unit-testable — the
// IPC handler does the I/O and feeds us canonical strings.
//
// Threat model note: a remote client is password-authed and can already drive
// Claude itself, so this is defense-in-depth, not a sandbox. The goal is that
// the binary-read IPC is never the EASIEST way to lift a file — reads are
// limited to the user's project folders and tracked artifacts, and well-known
// secret locations are refused even inside those roots.

// The sensitive-set definitions moved to shared/artifacts/editable-path-policy
// (D5, 2026-07-22) so the artifact WRITE boundary and this READ guard cannot
// drift apart — one set, two consumers. Behavior here is unchanged: reads still
// refuse dotenv (the write policy treats dotenv as confirm-tier instead; see
// protectedReadPath in that module for why the two differ).
import {
  SENSITIVE_SEGMENTS,
  SENSITIVE_BASENAMES,
  SENSITIVE_SUBPATHS,
  isDotenvBasename,
} from '../../shared/artifacts/editable-path-policy';

/** True when a canonical path points at a well-known secret location. */
export function isSensitivePath(canonicalPath: string): boolean {
  const parts = canonicalPath.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (isDotenvBasename(base)) return true;
  if (parts.some((seg) => SENSITIVE_SEGMENTS.has(seg))) return true;
  return SENSITIVE_SUBPATHS.some((sub) => canonicalPath.includes(sub));
}

/** True when `canonicalPath` is `root` itself or nested under it. Both inputs
 * must already be canonical (forward slashes, lowercased drive). */
export function isUnderRoot(canonicalPath: string, canonicalRoot: string): boolean {
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(canonicalRoot + '/');
}

export type BinaryReadVerdict = 'allowed' | 'sensitive' | 'outside-roots';

/**
 * Decide whether a binary read of `canonicalPath` is permitted.
 * - `canonicalRoots`: the user's known project roots (saved folders + central
 *   index projects), canonicalized.
 * - `trackedCanonicalPaths`: absolute canonical paths of tracked EXTERNAL
 *   artifacts / manual includes (covers e.g. a temp-dir xlsx the session
 *   drawer legitimately shows, which lives outside every root).
 */
export function evaluateBinaryRead(
  canonicalPath: string,
  canonicalRoots: string[],
  trackedCanonicalPaths: Set<string>
): BinaryReadVerdict {
  if (isSensitivePath(canonicalPath)) return 'sensitive';
  if (canonicalRoots.some((r) => isUnderRoot(canonicalPath, r))) return 'allowed';
  if (trackedCanonicalPaths.has(canonicalPath)) return 'allowed';
  return 'outside-roots';
}
