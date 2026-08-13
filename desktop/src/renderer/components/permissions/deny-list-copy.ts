// Copy for the Full-auto safety-stop footer (spec 2026-08-12, M5 2b).
// Classifies a deny-listed Bash command into the family that stopped it by
// re-matching against the SAME shared list + matcher the engine decided with
// (DESTRUCTIVE_DENY_LIST + subjectMatches) — so the card can never name a
// different reason than the engine had. First match in list order wins:
// the engine's last-match-wins is across LAYERS; within the deny-list layer
// every entry has the same action, so order carries no meaning and the list's
// own family grouping is safe to walk front-to-back.
import { DESTRUCTIVE_DENY_LIST } from '../../../shared/permission-types';
import { subjectMatches } from '../../../shared/subject-glob';

type DenyFamily = 'deleting' | 'pushing' | 'undoing' | 'admin' | 'formatting';

// Keyed on the deny-list PATTERN, not the raw command — the pattern is what
// the engine matched. If a new family joins DESTRUCTIVE_DENY_LIST without a
// row here, the footer uses the fallback — honest, just less specific
// (pinned by the fallback test).
const FAMILY_TESTS: Array<{ family: DenyFamily; match: (pattern: string) => boolean }> = [
  { family: 'deleting', match: (p) => /(^|\* )(rm|rmdir|del) \*/.test(p) },
  { family: 'pushing', match: (p) => p.includes('git push') },
  { family: 'undoing', match: (p) => p.includes('git reset --hard') },
  { family: 'admin', match: (p) => p.includes('sudo ') },
  { family: 'formatting', match: (p) => p.includes('format ') },
];

const HEADERS: Record<DenyFamily, string> = {
  deleting: 'Stopped before deleting files',
  pushing: 'Stopped before pushing code',
  undoing: 'Stopped before undoing commits',
  admin: 'Stopped before an admin command',
  formatting: 'Stopped before formatting a drive',
};

const CLAUSES: Record<DenyFamily, string> = {
  deleting: 'it permanently removes files.',
  pushing: 'it changes your published code.',
  undoing: 'it permanently discards saved work.',
  admin: 'it runs with full control of this computer.',
  formatting: 'it erases everything on it.',
};

// Owner-settled line (compare surface 'full-auto-ask', R3/R4) — "limits", em
// dash, lowercase clause. Don't reword without a new compare round.
const SUBLINE_BASE = 'YouCoded limits this action, even in Full Auto';

export function fullAutoStopCopy(command: string | undefined): { header: string; subline: string } {
  if (command) {
    for (const rule of DESTRUCTIVE_DENY_LIST) {
      if (!subjectMatches(command, rule.pattern)) continue;
      const fam = FAMILY_TESTS.find((f) => f.match(rule.pattern ?? ''))?.family;
      if (fam) return { header: HEADERS[fam], subline: `${SUBLINE_BASE} — ${CLAUSES[fam]}` };
    }
  }
  // Deny-listed per the engine but unclassifiable here (or command missing):
  // generic header, no invented consequence.
  return { header: 'Stopped before a risky command', subline: `${SUBLINE_BASE}.` };
}
