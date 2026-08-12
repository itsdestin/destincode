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
import { spillRoot } from './spill-paths';

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

/** Normalize a path for OUTPUT: backslashes → forward slashes, nothing else.
 *
 *  NOT `canonicalize()` above. That one also resolves against a cwd, collapses
 *  `..`, and LOWERCASES the whole path on win32 — right for the sensitive-path
 *  comparison sets it feeds, and destructive for anything a user or model reads
 *  back (every path the model sees would arrive lowercased on Windows).
 *
 *  Why this exists (2026-08-11): every harness tool must emit ONE path
 *  vocabulary on every platform. Glob normalized its separators; Grep printed
 *  ripgrep's stdout verbatim, so on Windows the same file came back as
 *  `src/a.ts` from one tool and `src\a.ts` from the other — the two are
 *  unpipeable between tools, which is the exact contract
 *  `harness-tool-bounds.test.ts` → "Grep and Glob agree on path format" pins. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// WHY this pair exists (two independent 2026-08 harness reviews, Grok 4.5 and
// Qwen 3.8 Max, hit the SAME asymmetry from opposite sides): Read/Glob/Grep
// always resolve a relative path from the workspace root; Bash resolves from
// its own persisted cwd, which `cd` moves. Both are documented, but a model
// mid-session can straddle the two — Grok assumed Read tracked the shell like
// Bash does; Qwen had `cd`'d into a subdirectory several calls earlier and
// then reused a root-relative path, watching a plain `grep` fail with no clue
// why. Neither half may GUESS: per docs/error-message-standards.md a wrong
// "did you mean" is worse than none, so both directions below confirm the
// alternative actually exists on disk before naming it — this is a
// deterministic disk check, not an inference.

/** Resolves `rawPath` under `altCwd` and returns the resolved absolute path
 *  IF something the caller recognizes actually exists there, else null.
 *  `exists` is injected so each caller asks its own question (a file for
 *  Read, a directory for Glob, "anything" for Grep/Bash). Null for an
 *  absolute `rawPath` too — an absolute path does not depend on either cwd,
 *  so there is no asymmetry to explain. */
export function resolveUnderAlternateCwd(
  rawPath: string,
  altCwd: string,
  exists: (absPath: string) => boolean,
): string | null {
  if (path.isAbsolute(rawPath)) return null;
  const candidate = path.resolve(altCwd, rawPath);
  return exists(candidate) ? candidate : null;
}

/** Read/Glob/Grep direction: a relative path just missed under the workspace
 *  root (`ctx.cwd`) — does it exist under the persisted Bash cwd instead?
 *  Returns a ready-to-append suffix (empty string when there is no such
 *  alternative: no persisted shell cwd, the shell cwd IS the workspace root,
 *  or the candidate genuinely doesn't exist either). Callers append this
 *  directly onto their own "failed"/"rejected" message — never a standalone
 *  sentence, per the house error-message style. */
export function shellCwdMissHint(
  rawPath: string,
  ctx: { cwd: string; shellCwd?: string },
  exists: (absPath: string) => boolean,
): string {
  if (!ctx.shellCwd) return '';
  if (canonicalize(ctx.shellCwd, ctx.cwd) === canonicalize(ctx.cwd, ctx.cwd)) return '';
  const hint = resolveUnderAlternateCwd(rawPath, ctx.shellCwd, exists);
  return hint ? ` It exists relative to the shell's current directory (${ctx.shellCwd}) instead — pass "${hint}".` : '';
}

/** Bash direction (Requirement B, the harder mirror image): a command just
 *  failed with the shell resolving `rawPath` under `failedCwd` (the
 *  persisted, possibly-`cd`-moved shell cwd) — does it exist under the
 *  workspace root instead? Same contract as shellCwdMissHint: empty string
 *  unless the alternative is CONFIRMED on disk. Bash callers additionally
 *  gate this on the failure text itself recognizably naming `rawPath` (see
 *  bash.ts) — arbitrary child-process stderr is not a structured error, so
 *  this function alone is not sufficient to fire the hint, only necessary. */
export function workspaceRootMissHint(
  rawPath: string,
  failedCwd: string,
  ctx: { cwd: string },
  exists: (absPath: string) => boolean,
): string {
  if (canonicalize(failedCwd, ctx.cwd) === canonicalize(ctx.cwd, ctx.cwd)) return '';
  const hint = resolveUnderAlternateCwd(rawPath, ctx.cwd, exists);
  return hint ? ` It exists relative to the workspace root (${ctx.cwd}) instead — pass "${hint}".` : '';
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
  // Bash's own spill files are readable without an external_directory ask.
  //
  // WHY (2026-08-11 review round 8): when Bash truncates, it saves the full
  // output under tmpdir and the result tells the model to "Read that file" —
  // but tmpdir is outside the workspace, so following that advice forced an
  // approval prompt, and in the review battery (where every ask is denied) it
  // was a closed loop: two models were told to read a file the harness would
  // never let them read. The advice and the guard have to agree, and the
  // advice is the correct half — the model is reading back output of a command
  // it already ran and already partly saw.
  //
  // Deliberately placed AFTER the credential denies above, so this can never
  // become a bypass: a path only reaches here once it has cleared them. Scoped
  // to spillRoot() and nothing else — that tree is written by this harness
  // alone, contains only Bash output, and is swept on a retention policy. It
  // widens nothing the threat model didn't already accept: per the KNOWN
  // LIMITATIONS at the top of this file, Bash can read any of it directly.
  if (isUnderRoot(canonical, canonicalize(spillRoot(), cwd))) return { kind: 'ok' };
  if (!isUnderRoot(canonical, canonicalize(cwd, cwd))) {
    return { kind: 'external', canonicalPath: canonical }; // → external_directory ask
  }
  return { kind: 'ok' };
}
