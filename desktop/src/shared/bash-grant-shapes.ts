// The grant options offered when the user picks "Always allow" on a Bash command.
//
// WHY this is in shared/ and not in main/: the sentence the user reads in the
// confirm and the rule the engine stores must come from ONE function. Two
// derivations would eventually disagree, and the disagreement would be a grant
// that is wider than the sentence describing it — the exact failure this item
// exists to fix. Same reasoning as subject-glob.ts's own header.
import { DESTRUCTIVE_DENY_LIST } from './permission-types';
import type { PermissionRule } from './permission-types';
import { ruleMatches } from './subject-glob';

export type GrantScope = 'exact' | 'wide';

export interface GrantOption {
  scope: GrantScope;
  /** Exactly what gets persisted. The renderer never constructs this — it sends
   *  the `scope` selector and the main process re-derives from the tool call. */
  rule: PermissionRule;
  /** Plain-English label. MUST NOT contain '*' or '?' — this string is rendered
   *  in the confirm and in Settings, on a screen written for people who have
   *  never seen a glob. */
  label: string;
}

// Commands a wide rung must never admit. One entry per destructive deny-list
// FAMILY, pinned by a test that fails if a family is added without one.
//
// WHY this exists at all: isDenyListed() below asks "is the command in front of
// the user dangerous?" — but the rule being offered covers commands nobody
// tested. `git --no-pager log` is not deny-listed and derives the rung `git*`,
// which then covers `git push origin master` and `git reset --hard` and, once
// stored, OUTRANKS the deny-list. Checking the rung against this corpus is the
// mirror image of the self-coverage postcondition, and the only thing standing
// between a mild-sounding button and a silent force-push.
//
// NOT in the corpus: a plain `git push origin master`. Pushing to master is
// something the user is deliberately allowed to grant (master is an ordinary
// branch), so it is not "hostile regardless of intent" — putting it here would
// refuse the very branch rung Task 3 exists to build. `git*` is still caught, by
// the --delete and --prune and reset --hard entries.
export const HOSTILE_CORPUS: readonly string[] = [
  'git push --delete origin master',
  'git push --prune origin master',
  'git reset --hard HEAD~1',
  'rm -rf /',
  'sudo rm -rf /',
  'rmdir /s /q C:\\Windows',
  'del /f /q C:\\boot.ini',
  'sudo apt-get install anything',
  'format c:',
];

interface CommandShape {
  /** Matched against `${program} ${subcommand}`. */
  key: string;
  /** False → NO "Always allow" of any kind, not even exact. Reserve this for the
   *  one situation an exact grant cannot honour either: the command text does not
   *  say what it will act on, because that resolves when it RUNS (bare
   *  `git push`). A command that is merely too complex to widen still gets its
   *  exact rung — remembering it byte-for-byte is as safe as any other exact
   *  grant, and refusing it means a repeated command that can never be answered
   *  permanently. */
  rememberable(tokens: string[]): boolean;
  /** The scoped wide rung, or null for "exact only". Never falls back to the
   *  generic rung: a shape exists precisely because the generic one is too wide
   *  for this command, so falling back would grant MORE, not less. */
  scope(tokens: string[]): { pattern: string; label: string } | null;
}

// Populated in Task 3.
const COMMAND_SHAPES: CommandShape[] = [];

/** Whitespace split that keeps quoted runs together. */
function tokenize(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

/** A word, as opposed to a flag, a path, or a quoted argument — i.e. plausibly a
 *  subcommand. The quote test matters: without it `echo "hi there"` derives a
 *  rung labelled `Any echo "hi there" command`, which is an argument masquerading
 *  as a verb. */
function isSubcommand(token: string | undefined): boolean {
  return !!token && !token.startsWith('-') && !/^["']/.test(token) && !/[/\\.]/.test(token);
}

/** `program sub` when the second token is a verb, else `program`. */
function shapeKey(tokens: string[]): string {
  return isSubcommand(tokens[1]) ? `${tokens[0]} ${tokens[1]}` : tokens[0];
}

function isDenyListed(command: string): boolean {
  return DESTRUCTIVE_DENY_LIST.some((r) => ruleMatches(r, command));
}

function wideRule(pattern: string): PermissionRule {
  return { tool: 'Bash', pattern, action: 'allow', match: 'glob' };
}

function deriveWide(command: string, tokens: string[]): GrantOption | null {
  const key = shapeKey(tokens);
  const shape = COMMAND_SHAPES.find((s) => s.key === key);
  if (shape) {
    const scoped = shape.scope(tokens);
    return scoped ? { scope: 'wide', rule: wideRule(scoped.pattern), label: scoped.label } : null;
  }

  // A deny-listed family with no shape row gets no widening: for rm / sudo /
  // format / git reset --hard the varying part IS the dangerous part, and there
  // is nothing that must precede an `rm` target the way a remote must precede a
  // push refspec, so it cannot be bounded to a single target.
  if (isDenyListed(command)) return null;

  return { scope: 'wide', rule: wideRule(`${key}*`), label: `Any ${key} command` };
}

/** Grant options for a Bash command, narrowest first.
 *
 *  An EMPTY array means no "Always allow" may be offered at all — the caller must
 *  suppress the button, not fall back to something. */
export function bashGrantOptions(command: string): GrantOption[] {
  const tokens = tokenize(command);
  if (tokens.length === 0) return [];

  const shape = COMMAND_SHAPES.find((s) => s.key === shapeKey(tokens));
  if (shape && !shape.rememberable(tokens)) return [];

  // The command is stored VERBATIM — never trimmed. permissionSubject hands the
  // engine args.command unchanged, so a trimmed pattern would differ from the
  // subject by a character the user cannot see and would never match again.
  const options: GrantOption[] = [
    { scope: 'exact', rule: { tool: 'Bash', pattern: command, action: 'allow', match: 'exact' }, label: command },
  ];
  const wide = deriveWide(command, tokens);
  if (wide) options.push(wide);

  return options.filter((o) => {
    // POSTCONDITION 1 — never offer a rung that cannot cover the command in front
    // of the user. Without it, `npm run build > log.txt` is offered "any npm run
    // command", a rule safety rule 1 immediately refuses, so the user saves a
    // grant, gets asked again identically, and nothing explains why.
    if (!ruleMatches(o.rule, command)) return false;
    // POSTCONDITION 2 — never offer a rung that admits a known-destructive
    // command. An exact rung is exempt: it covers exactly the string the user is
    // looking at, so approving `rm -rf build` is a decision, not a surprise.
    if (o.scope === 'exact') return true;
    return !HOSTILE_CORPUS.some((hostile) => ruleMatches(o.rule, hostile));
  });
}
