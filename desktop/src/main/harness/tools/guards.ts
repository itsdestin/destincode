// Tool-layer guards. These are NOT permission rules and no mode/preset/
// remembered decision reaches them: secret paths hard-deny; paths outside the
// session cwd force an 'ask' (the external_directory synthetic permission).
// KNOWN LIMITATIONS (spec §2.3, accepted — honest friction on the file tools,
// not a sandbox):
//   1. Bash can still `cat .env` — these guards only gate the native file tools.
//   2. Symlinks are NOT resolved: a link INSIDE cwd that points at ~/.ssh (or
//      anywhere outside) passes the jail, because we canonicalize the link path
//      lexically, not its realpath target. Deliberate — realpath would hit the
//      fs on every call and still race (TOCTOU). PITFALLS entry ships with this
//      file (Task 13).
import * as path from 'path';
import * as os from 'os';
import { isSensitivePath, isUnderRoot } from '../../artifacts/read-binary-access';

/** Canonicalize to the form isSensitivePath / isUnderRoot expect: forward
 * slashes, lowercased drive letter, no trailing slash on the root, `..` resolved.
 *  - path.resolve(cwd, p) ALWAYS: resolve() normalizes `..`/`.` AND ignores cwd
 *    when p is already absolute, so a lexical `C:/proj/../../secret` collapses to
 *    `C:/secret` instead of sneaking past the cwd jail (fix: the old isAbsolute
 *    branch skipped normalization for absolute inputs).
 *  - Windows is case-insensitive but the sensitive sets are all-lowercase, so we
 *    case-fold the WHOLE path on win32 (not just the drive) — otherwise `.SSH`,
 *    `.Env`, `.NETRC` evade the hard-deny. POSIX stays case-sensitive. */
export function canonicalize(p: string, cwd: string): string {
  const c = path.resolve(cwd, p).replace(/\\/g, '/');
  return process.platform === 'win32' ? c.toLowerCase() : c;
}

export function resolveP(p: string, cwd: string): string {
  // Always resolve() so absolute-with-`..` inputs are normalized, not trusted.
  return path.resolve(cwd, p);
}

export type GuardVerdict =
  | { kind: 'ok' }
  | { kind: 'deny'; reason: string }
  | { kind: 'external'; canonicalPath: string };

export function checkPathGuard(rawPath: string, cwd: string): GuardVerdict {
  const canonical = canonicalize(rawPath, cwd);
  // isSensitivePath already covers .ssh/.gnupg/.aws segments, credential
  // basenames, .config/gh, and (as of Phase 2) dotenv files.
  if (isSensitivePath(canonical)) {
    return { kind: 'deny', reason: `Access to ${rawPath} is blocked: it looks like a credential or secret file. This cannot be overridden.` };
  }
  // Belt-and-suspenders for the home credential dirs even when addressed
  // relatively — redundant with isSensitivePath's segment check, but keeps the
  // guard's intent legible and survives any future narrowing of that set.
  const home = canonicalize(os.homedir(), cwd);
  for (const secretDir of [`${home}/.ssh`, `${home}/.gnupg`, `${home}/.aws`]) {
    if (isUnderRoot(canonical, secretDir)) {
      return { kind: 'deny', reason: `Access to ${rawPath} is blocked: it is under a credential directory. This cannot be overridden.` };
    }
  }
  if (!isUnderRoot(canonical, canonicalize(cwd, cwd))) {
    return { kind: 'external', canonicalPath: canonical }; // → external_directory ask
  }
  return { kind: 'ok' };
}
