import {
  ContextFile, ContextGroup, ContextScope, LoadTiming, ContextKind,
} from '../../shared/project-context-types';

// WHY: pure mapper. The IO shell (project-context.ts) does directory listing and
// frontmatter parsing, then hands plain data here so this stays unit-testable.
export interface RuleEntry { file: string; glob?: string; absolutePath?: string }
export interface DiscoveryInput {
  projectRoot: string;
  homeDir: string;
  projectSlug: string;
  projectInstructionFiles: string[];   // basenames found (CLAUDE.md, AGENTS.md, …)
  projectInstructionPaths?: Record<string, string>; // basename → absolutePath
  projectRules: RuleEntry[];
  globalInstructionFiles: string[];
  globalInstructionPaths?: Record<string, string>;
  globalRules: RuleEntry[];
  memoryFiles: string[];               // basenames in the memory dir
  memoryPaths?: Record<string, string>;
}

function instrKind(basename: string): ContextKind {
  return basename.toUpperCase().startsWith('AGENTS') ? 'agents-md' : 'claude-md';
}

function mk(
  scope: ContextScope, kind: ContextKind, label: string, absolutePath: string,
  timing: LoadTiming, blastRadius: 'global' | 'project', glob?: string,
): ContextFile {
  return { id: `${scope}:${absolutePath}`, scope, kind, label, absolutePath, timing, glob, editable: true, blastRadius };
}

export function discoverContext(input: DiscoveryInput): ContextGroup[] {
  const project: ContextFile[] = [];
  const global: ContextFile[] = [];
  const memory: ContextFile[] = [];

  for (const f of input.projectInstructionFiles) {
    const p = input.projectInstructionPaths?.[f] ?? `${input.projectRoot}/${f}`;
    project.push(mk('project', instrKind(f), f, p, 'always', 'project'));
  }
  for (const r of input.projectRules) {
    const p = r.absolutePath ?? `${input.projectRoot}/.claude/rules/${r.file}`;
    project.push(mk('project', 'rule', r.file, p, r.glob ? 'conditional' : 'always', 'project', r.glob));
  }
  for (const f of input.globalInstructionFiles) {
    const p = input.globalInstructionPaths?.[f] ?? `${input.homeDir}/.claude/${f}`;
    global.push(mk('global', instrKind(f), f, p, 'always-everywhere', 'global'));
  }
  for (const r of input.globalRules) {
    const p = r.absolutePath ?? `${input.homeDir}/.claude/rules/${r.file}`;
    global.push(mk('global', 'rule', r.file, p, r.glob ? 'conditional' : 'always', 'global', r.glob));
  }
  for (const f of input.memoryFiles) {
    const p = input.memoryPaths?.[f] ?? `${input.homeDir}/.claude/projects/${input.projectSlug}/memory/${f}`;
    const isIndex = f === 'MEMORY.md';
    memory.push(mk('memory', isIndex ? 'memory-index' : 'memory-note', f, p, isIndex ? 'index' : 'on-recall', 'project'));
  }

  return [
    { scope: 'project', files: project },
    { scope: 'global', files: global },
    { scope: 'memory', files: memory },
  ];
}
