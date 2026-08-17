import type { SpecialistDefinitionView, DelegatedModelsView } from '../../../../shared/types';

// Specialists 1c — the roster the workbench serves for `specialists.list`.
// Four built-ins mirror harness/specialists/builtins.ts VERBATIM (tools +
// charter) so the consent block in the workbench says what the real child
// would get; the last three are what the definitions-folder work will
// produce: a personal file, a project file, and a Claude Code `.claude/agents`
// file whose grants had to be narrowed (spec §2: strip + visible warning).
export function specialistRoster(): SpecialistDefinitionView[] {
  return [
    {
      id: 'explorer', displayName: 'Explorer', source: 'builtin', charter: 'read-only',
      description: 'Finds things: files, code, facts. Reads and searches, never edits.',
      allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'], warnings: [], offered: true,
    },
    {
      id: 'researcher', displayName: 'Researcher', source: 'builtin', charter: 'read-only',
      description: 'Web-heavy research with sourced summaries.',
      allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'], warnings: [], offered: true,
    },
    {
      id: 'reviewer', displayName: 'Reviewer', source: 'builtin', charter: 'read-only',
      description: 'Checks finished work with fresh eyes. Sees only what it is handed, never the conversation.',
      allowedTools: ['Read', 'Glob', 'Grep'], warnings: [], offered: true,
    },
    {
      id: 'worker', displayName: 'Worker', source: 'builtin', charter: 'read-write',
      description: 'Does the work: edits files and runs commands. Only one Worker runs at a time.',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'], warnings: [], offered: true,
    },
    {
      id: 'docs-writer', displayName: 'Docs Writer', source: 'personal', charter: 'read-write',
      description: 'Writes and updates documentation in the project’s docs folder, matching the existing voice.',
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      path: '/home/destin/.youcoded/specialists/docs-writer.md', warnings: [], offered: true,
      modelPreference: 'budget',
    },
    {
      // Task 8 fix: was source: 'project' (a value the real catalog never
      // produces — a project's own .claude/agents/ file is tagged
      // 'claude-code', same as the user-level folder; only `path` tells them
      // apart). Kept as a SEPARATE fixture row from code-reviewer below so the
      // workbench still shows two distinct file-backed specialists.
      id: 'release-checker', displayName: 'Release Checker', source: 'claude-code', charter: 'read-only',
      description: 'Walks the release checklist and reports anything not ready.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      // Task 10 fix: was under a `.youcoded/specialists/` path — a folder the
      // real catalog never reads for a 'claude-code' source (that source is
      // always a CC-format .claude/agents/ file, project's own or user-level).
      // The stale path made definedBy() misreport this row's provenance.
      path: '/home/destin/youcoded-dev/wecoded-themes/.claude/agents/release-checker.md',
      offered: true,
      warnings: [
        'Asked for a shell (Bash) but is read-only, so Bash was removed. Give it the read-write charter if it really needs to run commands.',
      ],
    },
    {
      id: 'code-reviewer', displayName: 'code-reviewer', source: 'claude-code', charter: 'read-only',
      description: 'Expert code review specialist. Proactively reviews code for quality, security, and maintainability.',
      allowedTools: ['Read', 'Grep', 'Glob'],
      // Task 10: moved to the USER-level ~/.claude/agents (was the project's
      // own, same folder as release-checker above) so the fixture data shows
      // both definedBy() branches — "This project's…" and "Your ~/.claude…" —
      // instead of two rows that would always read the same.
      path: '/home/destin/.claude/agents/code-reviewer.md',
      offered: true,
      warnings: [
        '2 tools this file asked for don’t exist here and were removed: NotebookEdit, MultiEdit.',
      ],
    },
  ];
}

export function delegatedModels(): DelegatedModelsView {
  return {
    budget: null,
    // Ids match fixtures/providers.ts's catalog so ModelPicker shows the label.
    frontier: { providerId: 'pv-openrouter', modelId: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  };
}
