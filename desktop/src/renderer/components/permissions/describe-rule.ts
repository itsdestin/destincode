import type { PermissionRule } from '../../../shared/permission-types';

export interface RuleDescription {
  /** Plain-language action, e.g. "Run" or "Create or overwrite". */
  verb: string;
  /** The thing acted on. Absent for a tool-wide grant and for MCP tools,
   *  whose subject is already folded into `verb`. */
  subject?: string;
  /** True when the rule has no pattern, so it covers EVERY use of that tool.
   *  The UI must render this as visibly broader than a specific grant. */
  broad: boolean;
}

// WHY a lookup rather than the raw tool name: the store speaks in tool ids
// (Bash / Edit / Write), and YouCoded is built for non-developers — "Create or
// overwrite src/a.ts" is a sentence, "Write: src/a.ts" is a log line.
const VERBS: Record<string, string> = {
  Bash: 'Run',
  Edit: 'Edit',
  Write: 'Create or overwrite',
  Read: 'Read',
  Glob: 'Search for files in',
  Grep: 'Search the contents of',
  WebFetch: 'Fetch',
  WebSearch: 'Search the web for',
  Skill: 'Load the skill',
  NotebookEdit: 'Edit the notebook',
  TodoWrite: 'Update the to-do list',
  // A '*' rule is what Full-auto writes at the baseline. Nothing on this screen
  // should ever render the literal asterisk — that is rule syntax, and the
  // screen is written for people who have never seen a glob.
  '*': 'Do anything',
};

export function describeRule(rule: PermissionRule): RuleDescription {
  const broad = rule.pattern === undefined;

  // MCP grants are per-tool and namespaced `mcp__{server}__{tool}`. Split on the
  // FIRST '__' after the prefix: a server id may itself contain '__', and the
  // tool name is whatever remains.
  //
  // Never `broad`, even though an MCP rule has no pattern: the pattern axis does
  // not exist for MCP tools, so its absence is not a widening. The grant already
  // names one exact tool on one exact connection. Reporting it as "covers every
  // use" would put a scary badge on EVERY MCP row and teach the user to ignore
  // the badge on the tool-wide grants where it is true.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(rule.tool);
  if (mcp) {
    return { verb: `Use the ${mcp[2]} tool from the ${mcp[1]} connection`, broad: false };
  }

  const base = VERBS[rule.tool] ?? `Use ${rule.tool}`;
  // Nothing writes a deny rule today, but PermissionRule permits one — render it
  // as a block rather than silently as a grant.
  const verb = rule.action === 'deny' ? (rule.tool === 'Bash' ? 'Never run' : `Never ${base.toLowerCase()}`) : base;
  return { verb, subject: rule.pattern, broad };
}

// ── Grouping vocabulary ─────────────────────────────────────────────────────
//
// WHY this lives HERE and not in the component: the tool table above is already
// the one place that knows what a tool id means. A second tool→something map in
// PermissionsSection.tsx would be a table that silently disagrees with this one
// the first time a tool is added to only one of them.

/** Which group an approval is filed under in Settings → Permissions.
 *
 *  The management screen sorts by what an approval lets the assistant DO, not by
 *  tool id: someone scanning "Commands" and "File changes" can find the thing
 *  they regret approving without knowing that Bash and Edit are different
 *  things. `other` is the catch-all so a tool added later still lands somewhere
 *  visible instead of vanishing from the list. */
export type RuleKind = 'commands' | 'files' | 'connections' | 'other';

/** Render order — broadest consequence first. A remembered command runs on the
 *  machine, an edit changes a file, a connection only talks to something
 *  outside, and everything else is mostly reads. */
export const RULE_KIND_ORDER: readonly RuleKind[] = ['commands', 'files', 'connections', 'other'];

/** Group headings. Plain nouns, no tool ids — same audience as the verbs above. */
export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  commands: 'Commands',
  files: 'File changes',
  connections: 'Connections',
  other: 'Other',
};

const KIND_BY_TOOL: Record<string, RuleKind> = {
  Bash: 'commands',
  Edit: 'files',
  Write: 'files',
  NotebookEdit: 'files',
  WebFetch: 'connections',
  WebSearch: 'connections',
  // Read / Glob / Grep / Skill / TodoWrite fall through to `other` on purpose:
  // they never change anything, and rulesForMode already allows them at every
  // baseline, so a remembered rule for one is a rarity rather than a category.
};

export function ruleKind(rule: PermissionRule): RuleKind {
  // Every MCP tool is a connection to something outside the app, whatever the
  // individual tool happens to do once it gets there.
  if (rule.tool.startsWith('mcp__')) return 'connections';
  return KIND_BY_TOOL[rule.tool] ?? 'other';
}

/** What a pattern-less grant actually covers, in the user's words.
 *
 *  `describeRule` only reports THAT a rule is broad; the noun depends on the
 *  tool, which is why this reads the same table's vocabulary. */
export function broadNote(tool: string): string {
  if (tool === '*') return 'Covers everything the assistant can do, not just the one thing it first asked about.';
  if (tool === 'Bash') return 'Covers every command, not just the one it first asked about.';
  if (KIND_BY_TOOL[tool] === 'files' || tool === 'Read') {
    return 'Covers every file, not just the one it first asked about.';
  }
  return 'Covers every use of this tool, not just the one it first asked about.';
}
