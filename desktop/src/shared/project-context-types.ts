export type ContextScope = 'project' | 'global' | 'memory';
export type LoadTiming =
  | 'always' | 'always-everywhere' | 'conditional' | 'on-recall' | 'index';
export type ContextKind =
  | 'claude-md' | 'agents-md' | 'rule' | 'memory-index' | 'memory-note';

export interface ContextFile {
  id: string;            // stable: `${scope}:${absolutePath}`
  scope: ContextScope;
  kind: ContextKind;
  label: string;         // display name (filename or rule/memory slug)
  absolutePath: string;
  timing: LoadTiming;
  glob?: string;         // set when timing === 'conditional'
  editable: boolean;     // true in v1
  blastRadius: 'global' | 'project';
}

export interface ContextGroup {
  scope: ContextScope;
  files: ContextFile[];
}

// Recognized agent-instruction filenames. Format-agnostic so future harnesses
// (opencode, gemini, custom) are surfaced without code changes.
export const RECOGNIZED_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;
