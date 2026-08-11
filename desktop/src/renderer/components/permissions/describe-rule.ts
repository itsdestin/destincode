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
