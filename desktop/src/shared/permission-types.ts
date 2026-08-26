// Phase 2 permission model (spec §2.4). Shared: main evaluates, renderer
// displays mode labels and the deny-listed Always-allow warning.
export type PermissionAction = 'allow' | 'ask' | 'deny';

// Session-level mode for NATIVE sessions (distinct from CC's PermissionMode —
// CC's is PTY-scraped; this is real state owned by NativeSessionHost).
export type NativePermissionMode = 'ask' | 'auto-edit' | 'full-auto';

export interface PermissionRule {
  /** Tool name or '*'; also the synthetic subjects 'doom_loop' | 'max_steps' | 'external_directory'. */
  tool: string;
  /** Glob over the SUBJECT (Bash: command string; file tools: relative path). Absent = matches any. */
  pattern?: string;
  action: PermissionAction;
  /** How `pattern` is compared. ABSENT MEANS 'glob' — that default is load-bearing:
   *  every DESTRUCTIVE_DENY_LIST entry and every mode/preset rule omits this field
   *  and must keep globbing. Only remembered rules ever set it.
   *
   *  WHY a field instead of escaping '*' inside the pattern: subjectMatches escapes
   *  '\' as a regex literal, so a backslash escape syntax would break Windows
   *  commands like `del C:\foo\*`. A discriminator sidesteps that entirely. */
  match?: 'exact' | 'glob';
  /** Task 11: the specialist agentType (e.g. 'worker') this rule is scoped to.
   *  Absent means the rule is the ROOT session's own grant — a plain
   *  PermissionRule from before specialists existed, or a preset/deny-list/
   *  mode-baseline entry, none of which are ever specialist-scoped. Rule
   *  IDENTITY is the QUINT (tool, pattern, action, match, specialist)
   *  everywhere a remembered rule is deduped, removed, matched, or displayed —
   *  declared here on the base type (not only on StoredRule below) because the
   *  scope filter that keeps a specialist-keyed grant from leaking to the
   *  root session or a different specialist type (native-session-host.ts's
   *  buildDecide) has to read it off the SAME rule objects decidePermission
   *  consumes, not a separate UI-only shape. */
  specialist?: string;
}

/** A rule read off disk, in the semantics it was WRITTEN with.
 *
 *  WHY: every rule ever persisted came from harness-session's `remember-rule`,
 *  which stored the raw tool subject — an exact command or path that was then
 *  evaluated as a glob. So `rm *.tmp` became a wildcard grant nobody asked for.
 *  Reading a match-less rule as 'exact' restores the promise the user was shown
 *  ("Always allow this exact command") and only ever ALLOWS LESS.
 *
 *  Apply this to REMEMBERED rules only. A deny-list or mode rule has no `match`
 *  on purpose (see the field's doc) and must never be run through here. */
export function normalizeRule<T extends PermissionRule>(rule: T): T {
  return rule.match ? rule : { ...rule, match: 'exact' };
}

/** Rule identity: the QUINT (tool, pattern, action, match, specialist). Two grants
 *  that differ only in `match` are different grants — collapsing them makes Settings
 *  revoke the wrong one. Two grants that differ only in `specialist` are ALSO
 *  different grants — collapsing THOSE would let a specialist's own grant satisfy
 *  (or get revoked by) the root session's, which is exactly the leak Task 11 added
 *  `specialist` to prevent. `grantedAt` is deliberately excluded so re-approving
 *  something does not look like a fresh grant.
 *
 *  Normalizes BOTH sides, so a rule read straight off disk (no `match`) compares
 *  equal to the same rule after a read through PermissionStore (`match: 'exact'`).
 *  Callers therefore never have to remember to normalize first — one default for
 *  an absent `match`, in one place. `specialist` needs no such normalization:
 *  absent already means "root session's own grant" on both sides of any read path. */
export function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  const x = normalizeRule(a);
  const y = normalizeRule(b);
  return x.tool === y.tool && x.pattern === y.pattern && x.action === y.action &&
    x.match === y.match && x.specialist === y.specialist;
}

/** A remembered rule as STORED — the engine's PermissionRule plus provenance
 *  the engine never reads. `grantedAt` is absent on every rule written before
 *  the management UI existed; the UI shows no date rather than inventing one. */
export interface StoredRule extends PermissionRule {
  /** ISO-8601. Absent on pre-existing rules. */
  grantedAt?: string;
}

/** One project's slice of permissions.json, as the management UI reads it.
 *  `cwd` is absent for entries written before the UI existed: nativeStoreSlug
 *  collapses ':', '\', '/' AND spaces all to '-', so the original path is NOT
 *  recoverable from the slug. That is why removal keys by slug, not cwd. */
export interface StoredProject {
  slug: string;
  cwd?: string;
  rules: StoredRule[];
}

export interface PermissionDecision {
  action: PermissionAction;
  /** True when the winning rule came from the destructive deny-list — drives
   *  the consequence-gated "Always allow" warning (spec §2.4 precedence ruling). */
  denyListed: boolean;
  /** Optional model-facing refusal detail. When absent, harness-session renders
   *  its generic "blocked by a permission rule" copy — which is what every
   *  existing caller (decidePermission) still gets. Added for specialists
   *  (plan 1a): a child refused a tool needs to know WHY ("not available to this
   *  specialist") or a weak model will just retry the same call until its step
   *  budget runs out. Model-facing text, not user-facing error copy. */
  message?: string;
}

// The destructive deny-list: CONFIGURATION, not a tool-layer guard. Ships in
// every mode baseline (Full-auto included). An explicit remembered user rule
// wins over it (spec review ruling #2) — that's why these are 'ask', not 'deny':
// the user stays sovereign, the model never proceeds silently.
// Each base pattern has a '* …' compound variant because the Task-3 matcher
// anchors patterns ^…$, so a bare 'git push*' won't catch 'cd repo && git push'.
// Over-matching is fail-safe here because the action is only 'ask': an
// unnecessary ask is merely annoying, while a missed destructive command in
// Full-auto is the failure that actually matters.
export const DESTRUCTIVE_DENY_LIST: PermissionRule[] = [
  { tool: 'Bash', pattern: 'rm *', action: 'ask' },
  { tool: 'Bash', pattern: '* rm *', action: 'ask' },
  { tool: 'Bash', pattern: 'rmdir *', action: 'ask' },
  { tool: 'Bash', pattern: '* rmdir *', action: 'ask' },
  { tool: 'Bash', pattern: 'del *', action: 'ask' },
  { tool: 'Bash', pattern: '* del *', action: 'ask' },
  { tool: 'Bash', pattern: 'git push*', action: 'ask' },
  { tool: 'Bash', pattern: '* git push*', action: 'ask' },
  { tool: 'Bash', pattern: 'git reset --hard*', action: 'ask' },
  { tool: 'Bash', pattern: '* git reset --hard*', action: 'ask' },
  { tool: 'Bash', pattern: 'sudo *', action: 'ask' },
  { tool: 'Bash', pattern: '* sudo *', action: 'ask' },
  { tool: 'Bash', pattern: 'format *', action: 'ask' },
  { tool: 'Bash', pattern: '* format *', action: 'ask' },
];

/** Mode baselines (spec §2.4 layer 2). Reads + web are free in EVERY preset and
 *  mode (spec §3.4 "reads + web free"): local reads (Read/Glob/Grep), TodoWrite,
 *  and the web pair (WebFetch/WebSearch) never prompt at the baseline. Higher
 *  layers (deny-list, remembered/denied rules) still override via last-match-wins. */
export function rulesForMode(mode: NativePermissionMode): PermissionRule[] {
  const alwaysAllowed: PermissionRule[] = [
    { tool: 'Read', action: 'allow' },
    { tool: 'Glob', action: 'allow' },
    { tool: 'Grep', action: 'allow' },
    { tool: 'TodoWrite', action: 'allow' },
    { tool: 'WebFetch', action: 'allow' },
    { tool: 'WebSearch', action: 'allow' },
    // Skill is a READ, and a narrower one than Read itself: it opens exactly one
    // file, in a directory the app discovered, chosen from a list the app itself
    // advertised. Returning that text has no side effect — every action a skill
    // INSTRUCTS is performed by some other tool, which is gated on its own terms.
    // Prompting here would add friction with no safety gained, and would train the
    // user to click through prompts that never matter (M3 item 1).
    { tool: 'Skill', action: 'allow' },
    // Task 14: ModelSearch reads public catalog metadata only (no provider
    // keys, no session state) and attaches only alongside Task — same
    // "narrow read, never worth an ask" reasoning as Skill just above.
    { tool: 'ModelSearch', action: 'allow' },
  ];
  switch (mode) {
    case 'ask':
      return [{ tool: '*', action: 'ask' }, ...alwaysAllowed];
    case 'auto-edit':
      return [{ tool: '*', action: 'ask' }, ...alwaysAllowed,
        { tool: 'Edit', action: 'allow' }, { tool: 'Write', action: 'allow' },
        // Task (Task 6, spec §5 walk-away autonomy — a PINNED decision, not an
        // accident): delegating to a specialist grants that specialist nothing
        // beyond what THIS mode already grants the parent directly. auto-edit
        // already lets the parent Edit/Write itself with no ask, so spawning a
        // write-capable specialist to do the same work needs no extra ask
        // either. Deliberately absent from `alwaysAllowed` (the 'ask' baseline
        // below): under 'ask' mode, the Task call itself IS the one moment the
        // user consents to the whole delegated envelope — see permissionSubject
        // in tools/task.ts.
        { tool: 'Task', action: 'allow' },
        // D1 (2026-08-26) — the allow above is pattern-less, so before this rule
        // it covered EVERY hire, including a specialist defined by a file some
        // repo shipped. In auto-edit that meant no card rendered at all, which
        // silently bypassed BOTH halves of the plan-1c safety design (the
        // file-scoped subject in tools/task.ts, and the renderer's consent card)
        // — neither can protect anyone if the engine answers before either runs.
        // Last-match-wins (permission-engine.ts) makes this narrower rule beat
        // the broad allow just above for exactly the file-defined case.
        // ':file:' is present in a file-defined hire's subject and in no
        // built-in's; a work dir that somehow contained that literal text would
        // only cause an EXTRA ask, which is the safe direction to be wrong in.
        { tool: 'Task', pattern: '*:file:*', action: 'ask' }];
    case 'full-auto':
      return [{ tool: '*', action: 'allow' }];
  }
}
