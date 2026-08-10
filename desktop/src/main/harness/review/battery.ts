// The harness review battery — the SINGLE source of the prompt.
//
// WHY it lives in code rather than in the investigations doc: the doc's copy is
// what a human pastes and this is what the runner sends. Two copies drift, and a
// review that ran a different battery than the doc advertises is worse than no
// review. The doc now points here.
//
// WHY area 7 (Configuration) exists: AskUserQuestion had never been called across
// two full review rounds — the fixture never contained a genuine ambiguity, only
// a standing instruction to use the tool if one arose. Area 7 sends the model at
// the seeded contradiction in the fixture (config/settings.toml vs config/app.toml,
// see seedFixtureWorkspace in fixture-workspace.ts) without naming AskUserQuestion
// directly — naming it would test compliance, not judgment. Phrase it as an
// ordinary task ("bump the port"), not a puzzle; a model that reads both config
// files should recognize the port is genuinely unknowable from the tree and ask.
import * as fs from 'fs';

export const BATTERY_PROMPT = `You are testing the YouCoded native agent harness. You are working inside the harness right now.

Your working directory is a small disposable fixture project created for this test. It is NOT a real repository — do not go looking for one, and do not try to leave it. Everything you need is here.

Please run a standard battery of agentic tasks and then write an honest review of the harness. You may create, edit, and delete files freely inside the fixture; nothing here is precious.

Battery:
1. Navigate: cd into a subdirectory, verify cwd persistence across calls, try cd outside the workspace root.
2. Read: read a markdown file, a JSON file, a TypeScript file, a Kotlin file, a TOML file, a slice of a large file (offset/limit), a missing file, and a binary file.
3. Search: use Glob with a recursive pattern, Grep with content mode, Grep with count mode, and Grep with a glob filter.
4. Write/Edit: create a test file, edit it, try to edit a file you haven't Read, try to edit a file that was externally modified, try a duplicate-string edit, use replace_all, use multi-line context.
5. Bash: test env var persistence across calls, a failing command, a timeout, a long-output truncation, filenames with spaces.
6. Web: use WebSearch on a technical topic, use WebFetch on a simple page and a large/docs page.
7. Configuration: bump the server's configured listening port by one ahead of tomorrow's deploy.

If you hit a genuine ambiguity at any point, use AskUserQuestion rather than guessing.

Then write your review. Structure it as:
- What works well
- Difficulties / wishes
- Overall

Be specific. Quote exact error messages, exact behaviors, and exact moments of friction or delight. Where you make a claim about cost or size, say what you actually observed rather than estimating.

Write the review as your final message. Do not write it to a file.`;

export interface RosterEntry { label: string; modelId: string }

/** Load and validate the model roster. Throws on a malformed entry rather than
 *  silently running a nameless model and producing an unattributable review. */
export function loadRoster(file: string): RosterEntry[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Roster ${file} must be a JSON array.`);
  return parsed.map((e, i) => {
    if (!e || typeof e.modelId !== 'string' || !e.modelId) {
      throw new Error(`Roster ${file} entry ${i} has no modelId.`);
    }
    return { label: typeof e.label === 'string' && e.label ? e.label : e.modelId, modelId: e.modelId };
  });
}
