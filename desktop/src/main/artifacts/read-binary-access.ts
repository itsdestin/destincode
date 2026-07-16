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

/** Directory segments that are refused anywhere in the path, even inside an
 * allowed project root (the seeded "Home" folder makes most of the home dir a
 * root, so the root check alone doesn't protect these). */
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube']);

/** Basenames refused outright (credential stores). */
const SENSITIVE_BASENAMES = new Set(['.netrc', '_netrc', '.credentials.json']);

/** True when a basename is a dotenv file (`.env`, `.env.local`, `.env.production`,
 * …) or a direnv `.envrc`. Added for the native tool-layer path guards (Phase 2):
 * dotenv files are the single most common place project secrets (API keys, DB
 * passwords) live, and `.envrc` (direnv) routinely holds `export SECRET=…` lines,
 * so the file tools hard-deny them the same way as other credential stores.
 * Matches the exact `.env` name plus any `.env.<suffix>` variant and `.envrc`, but
 * NOT unrelated names that merely start with the letters (e.g. `.environment`). */
function isDotenvBasename(base: string): boolean {
  return base === '.env' || base === '.envrc' || base.startsWith('.env.');
}

/** `.config/gh` holds the GitHub OAuth token (hosts.yml). */
const SENSITIVE_SUBPATHS = ['/.config/gh/'];

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
