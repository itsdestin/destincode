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

export interface PermissionDecision {
  action: PermissionAction;
  /** True when the winning rule came from the destructive deny-list — drives
   *  the consequence-gated "Always allow" warning (spec §2.4 precedence ruling). */
  denyListed: boolean;
}

// The destructive deny-list: CONFIGURATION, not a tool-layer guard. Ships in
// every mode baseline (Full-auto included). An explicit remembered user rule
// wins over it (spec review ruling #2) — that's why these are 'ask', not 'deny':
// the user stays sovereign, the model never proceeds silently.
export const DESTRUCTIVE_DENY_LIST: PermissionRule[] = [
  { tool: 'Bash', pattern: 'rm *', action: 'ask' },
  { tool: 'Bash', pattern: '* rm *', action: 'ask' },
  { tool: 'Bash', pattern: 'rmdir *', action: 'ask' },
  { tool: 'Bash', pattern: 'del *', action: 'ask' },
  { tool: 'Bash', pattern: 'git push*', action: 'ask' },
  { tool: 'Bash', pattern: 'git reset --hard*', action: 'ask' },
  { tool: 'Bash', pattern: 'sudo *', action: 'ask' },
  { tool: 'Bash', pattern: 'format *', action: 'ask' },
];

/** Mode baselines (spec §2.4 layer 2). Read/search tools are always free. */
export function rulesForMode(mode: NativePermissionMode): PermissionRule[] {
  const readOnly: PermissionRule[] = [
    { tool: 'Read', action: 'allow' },
    { tool: 'Glob', action: 'allow' },
    { tool: 'Grep', action: 'allow' },
    { tool: 'TodoWrite', action: 'allow' },
  ];
  switch (mode) {
    case 'ask':
      return [{ tool: '*', action: 'ask' }, ...readOnly];
    case 'auto-edit':
      return [{ tool: '*', action: 'ask' }, ...readOnly,
        { tool: 'Edit', action: 'allow' }, { tool: 'Write', action: 'allow' }];
    case 'full-auto':
      return [{ tool: '*', action: 'allow' }];
  }
}
