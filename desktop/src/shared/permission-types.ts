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
}

/** A remembered rule as STORED — the engine's PermissionRule plus provenance
 *  the engine never reads. `grantedAt` is absent on every rule written before
 *  the management UI existed; the UI shows no date rather than inventing one. */
export interface StoredRule extends PermissionRule {
  /** ISO-8601. Absent on pre-existing rules. */
  grantedAt?: string;
}

/** One project's slice of permissions.json, as the management UI reads it.
 *  `cwd` is absent for entries written before the UI existed: cwdToProjectSlug
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
        { tool: 'Task', action: 'allow' }];
    case 'full-auto':
      return [{ tool: '*', action: 'allow' }];
  }
}
