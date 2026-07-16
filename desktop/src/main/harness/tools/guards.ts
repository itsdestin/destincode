// Tool-layer guards. These are NOT permission rules and no mode/preset/
// remembered decision reaches them: secret paths hard-deny; paths outside the
// session cwd force an 'ask' (the external_directory synthetic permission).
// KNOWN LIMITATION (spec §2.3, accepted): Bash can still `cat .env` — these
// guards are honest friction on the file tools, not a sandbox. PITFALLS entry
// ships with this file (Task 13).
import * as path from 'path';
import * as os from 'os';
import { isSensitivePath, isUnderRoot } from '../../artifacts/read-binary-access';

/** Canonicalize to forward slashes + lowercase drive, matching read-binary-access
 * conventions (isSensitivePath / isUnderRoot expect exactly this form: forward
 * slashes, lowercased drive letter, no trailing slash). */
export function canonicalize(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  let c = abs.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(c)) c = c[0].toLowerCase() + c.slice(1);
  return c;
}

export function resolveP(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
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
