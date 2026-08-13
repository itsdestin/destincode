// Lives in shared/ because the renderer's deny-list copy module
// (components/permissions/deny-list-copy.ts) must classify with the SAME
// matcher the engine decided with — two matchers would eventually disagree.
// Tiny glob for permission SUBJECTS (bash command strings, relative paths).
// Homegrown on purpose: no new dep, and `*` must cross path separators here
// ("git push*" must match "git push origin x") — unlike file globbing.
// `*` also matches the empty string, so a bare "git push" matches "git push*".
import type { PermissionRule } from './permission-types';

export function subjectMatches(subject: string, pattern?: string): boolean {
  if (pattern === undefined) return true;
  const rx = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars EXCEPT * and ?
      .replace(/\*/g, '[\\s\\S]*')
      .replace(/\?/g, '.') + '$',
    'i',
  );
  return rx.test(subject);
}

/** Each one starts a SECOND command, or redirects the first one's output.
 *  subjectMatches compiles '*' to [\s\S]* on purpose — that is what lets the
 *  deny-list's '* rm *' catch 'cd repo && rm -rf x' — which means a trailing '*'
 *  in a GRANT would cross them too. */
export const SHELL_OPERATORS: readonly string[] = ['&&', '||', ';', '|', '`', '$(', '>', '<', '\n'];

/** Flags that change WHAT a bounded grant does rather than how it does it.
 *  `git push --delete origin feat/x` matches a rule built for
 *  `git push origin feat/x` — the wildcard sits between them — and deletes the
 *  branch the grant is named after. `--prune` deletes every OTHER branch on the
 *  remote; `--all` and `--mirror` push refs the grant never mentioned; `--force`
 *  and `--hard` destroy history rather than adding to it. */
export const BOUNDED_RUNG_VETO: readonly string[] = [
  '--delete', '-d', '--prune', '--mirror', '--all',
  '--force', '-f', '--force-with-lease', '--hard',
];

/** The ONE function that knows what a whole rule means. `subjectMatches` above is
 *  the primitive; this owns `match` and the two safety rules on top of it.
 *
 *  Every decision path must go through here — the engine AND the renderer's
 *  deny-list classifier — or the two will eventually disagree about what a rule
 *  covers, which is the bug the shared location of this file exists to prevent. */
export function ruleMatches(rule: PermissionRule, subject: string): boolean {
  // Exact: byte-for-byte, no regex, no metacharacter interpretation, and
  // case-SENSITIVE — the 'i' flag in subjectMatches is a widening the exact
  // promise cannot afford ('RM -rf /' is not 'rm -rf /' on the platforms Bash
  // runs on). No trimming either: the stored pattern IS the approved command.
  if (rule.match === 'exact') return rule.pattern !== undefined && subject === rule.pattern;
  if (!subjectMatches(subject, rule.pattern)) return false;

  const pattern = rule.pattern;
  // The safety rules below narrow WILDCARD BASH GRANTS only:
  //  * action !== 'allow' — the deny-list is 'ask' and MUST keep crossing
  //    operators, or '* rm *' stops catching 'cd x && rm -rf y'.
  //  * no pattern — a tool-wide grant ('*' in Full-auto) is a separate, explicit
  //    choice the Settings screen already flags as broad. Not our business here.
  //  * no wildcard — a literal pattern already matches exactly one string.
  //  * tool !== 'Bash' — every other subject is a path or an id, not a shell line.
  if (rule.action !== 'allow' || rule.tool !== 'Bash' || pattern === undefined) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return true;

  // SAFETY RULE 1 — a wildcard never swallows a second command.
  if (SHELL_OPERATORS.some((op) => subject.includes(op) && !pattern.includes(op))) return false;

  // SAFETY RULE 2 — a wildcard in the MIDDLE never swallows a destructive flag.
  // Text after the wildcard means the rule is naming a bounded target ("pushing
  // to feat/x"); the flags that would unbind it are vetoed. A pattern that ENDS
  // in its wildcard ('npm run*') is honestly open-ended and is exempt.
  const bounded = !/[*?]$/.test(pattern);
  if (bounded) {
    for (const raw of subject.split(/\s+/)) {
      const token = raw.split('=')[0]; // --force-with-lease=origin/x
      if (BOUNDED_RUNG_VETO.includes(token) && !pattern.includes(token)) return false;
    }
  }
  return true;
}
