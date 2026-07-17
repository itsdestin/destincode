// Assembled ONCE per session (spec §2.2): the <env> values are a SNAPSHOT at
// session start, labeled as such — the model uses tools for current state.
// Byte-stable by construction; do NOT add anything that changes between turns.
//
// WHY not reuse project-context.ts / context-discovery.ts: the former is a pure
// mapper over pre-computed basenames and the latter only scans the exact project
// dir + .claude (async, for the context UI). Neither does the session-start
// walk-up-to-git-root that the assembled prompt needs, so this owns its own IO.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { PromptVariant } from './capability-profile';
import { variantOverlay } from './prompts/variants';

// promptVariant is the capability-profile steering overlay (see prompts/variants.ts).
// Optional so pre-variant callers assemble byte-identically; only local-small adds text.
// hasTools defaults true; a tool-less model (profile.supportsTools === false, e.g.
// Gemma 3n) sets it false so the assembled prompt drops BOTH the tool-guidance line
// and the variant overlay — every overlay references tools the model doesn't have.
export interface PromptInputs { presetBody: string; cwd: string; appVersion: string; promptVariant?: PromptVariant; hasTools?: boolean }

function gitSnapshot(cwd: string): string {
  try {
    // stdio ignores stderr so a non-git cwd doesn't spam the main-process log
    // with `fatal: not a repository`; stdout is still captured, catch still fires.
    const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return `Git branch: ${branch}${dirty ? ` (${dirty.split('\n').length} uncommitted change(s))` : ' (clean)'}`;
  } catch { return 'Git: not a repository'; }
}

function projectInstructions(cwd: string): string | null {
  // Walk up from cwd to the git root (or filesystem root), first hit wins:
  // AGENTS.md is the cross-tool standard; CLAUDE.md read as fallback (§3.4).
  let dir = cwd;
  while (true) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        const body = fs.readFileSync(p, 'utf8').slice(0, 20_000);
        // NOT sanitizing: repo instruction files are trusted-by-design input. The
        // tag is a labeling convention, not a security boundary — a file with a
        // literal </project-instructions> can escape it, and that's acceptable here.
        return `<project-instructions source="${name}">\n${body}\n</project-instructions>`;
      }
    }
    // .git check runs AFTER trying the files, so a root-level AGENTS.md is found
    // before we stop; then break so the walk never escapes the repo.
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function assembleSystemPrompt(i: PromptInputs): string {
  // Tool-less model (profile.supportsTools === false → buildAiTools() returns {}):
  // it runs as plain chat, so telling it to "prefer dedicated tools" or to "call
  // one tool at a time" (the variant overlay) is nonsense guidance for tools it
  // was never given. Drop both. Everything else (identity, preset, env, project
  // instructions) is tool-agnostic and stays. Default true → unchanged behavior.
  const hasTools = i.hasTools !== false;
  const sections = [
    'You are the YouCoded assistant, an agentic AI running inside the YouCoded app.',
    i.presetBody,
    [
      '<env note="snapshot at session start — use tools (Bash, Read) for current state">',
      `Working directory: ${i.cwd}`,
      `Platform: ${process.platform} (${process.arch})`,
      `Date: ${new Date().toDateString()}`,
      gitSnapshot(i.cwd),
      `YouCoded version: ${i.appVersion}`,
      '</env>',
    ].join('\n'),
    projectInstructions(i.cwd),
    // Tool-guidance line — only when the model actually HAS tools.
    hasTools
      ? 'Prefer dedicated tools over shell: Read/Glob/Grep instead of cat/find/grep. Keep edits minimal and verify your work by running relevant commands after changing code.'
      : null,
    // Capability-steering overlay, appended LAST: personality (preset body) and
    // tool-calling steering (variant) are orthogonal axes composed by append. The
    // no-op variants return '' and are dropped by the empty-string filter below,
    // keeping default/anthropic/gpt byte-identical to a call with no variant. A
    // tool-less model skips it entirely (all overlays are tool-calling steering).
    hasTools ? variantOverlay(i.promptVariant) : '',
  ].filter((s): s is string => s !== null && s !== '');
  return sections.join('\n\n');
}
