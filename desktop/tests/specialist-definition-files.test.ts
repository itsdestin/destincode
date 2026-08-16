import { describe, it, expect } from 'vitest';
import {
  loadPersonalDefinition,
  loadClaudeCodeDefinition,
  deriveCharter,
  slugifyId,
  READ_ONLY_DEFAULT_TOOLS,
  STARTER_FILE_NAME,
  STARTER_FILE_CONTENTS,
} from '../src/main/harness/specialists/definition-files';
import { BUILTIN_SPECIALISTS } from '../src/main/harness/specialists/builtins';

// One `it` per row of spec §3.2 (the Claude Code mapping table) plus the
// personal-format rules above it — every mapping rule earns its own test so a
// future edit to the table can't silently drop a row without a red test.
describe('loadPersonalDefinition', () => {
  it('personal: omitted tools → read-only trio + warning', () => {
    const result = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test specialist.\n---\nDo the thing.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(READ_ONLY_DEFAULT_TOOLS);
    expect(result.value.warnings).toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  it('personal: unknown tool stripped with a warning naming it', () => {
    const raw = '---\ndescription: Test.\ntools: [Read, Frobnicate, Sparkle]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain(
      '2 tools this file asked for don’t exist here and were removed: Frobnicate, Sparkle',
    );
  });

  it('personal: a single unknown tool uses singular grammar', () => {
    const raw = '---\ndescription: Test.\ntools: [Read, Frobnicate]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain('1 tool this file asked for doesn’t exist here and was removed: Frobnicate');
  });

  it('personal: Task is always stripped', () => {
    const raw = '---\ndescription: Test.\ntools: [Read, Task]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain('specialists can’t hire specialists — Task was removed');
  });

  it('personal: charter is DERIVED — a file cannot claim read-only while holding Bash', () => {
    const raw = '---\ndescription: Test.\ncharter: read-only\ntools: [Bash]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.charter).toBe('read-write');
    expect(result.value.warnings).toContain('charter is not a setting — it follows the tools');
  });

  it('personal: empty body → error', () => {
    const raw = '---\ndescription: Test.\n---\n   \n';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('no instructions below the frontmatter');
  });

  it('personal: description required — missing → error', () => {
    const result = loadPersonalDefinition('/x/foo.md', '---\nname: Foo\n---\nDo the thing.');
    expect(result.ok).toBe(false);
  });

  it('personal: id defaults to the filename stem, slugified', () => {
    const result = loadPersonalDefinition('/some/dir/Docs Writer.md', '---\ndescription: Test.\n---\nDo the thing.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('docs-writer');
  });
});

describe('loadClaudeCodeDefinition', () => {
  it('cc: comma-separated tools parse', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, Grep, Bash\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('cc: MultiEdit → Edit warning', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, MultiEdit\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain('MultiEdit was removed — Edit covers it');
  });

  it('cc: a single unavailable tool uses singular grammar', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, mcp__foo__bar\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain(
      '1 tool this file asked for isn’t available to helpers here and was removed: mcp__foo__bar',
    );
  });

  it('cc: mcp__* stripped', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, NotebookEdit, mcp__foo__bar\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain(
      '2 tools this file asked for aren’t available to helpers here and were removed: NotebookEdit, mcp__foo__bar',
    );
  });

  it('cc: Task/Agent always stripped', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, Task, Agent\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain('specialists can’t hire specialists — Task was removed');
  });

  it('cc: omitted tools → read-only + warning', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(READ_ONLY_DEFAULT_TOOLS);
    expect(result.value.warnings).toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  it('cc: disallowedTools subtracts after mapping', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, Write, Edit, Bash\ndisallowedTools: Bash\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('cc: model haiku→budget, opus→frontier, sonnet→parent, weird→parent+warning', () => {
    const haiku = loadClaudeCodeDefinition('/agents/a.md', '---\nname: A\ndescription: Test.\nmodel: haiku\n---\nDo it.');
    const opus = loadClaudeCodeDefinition('/agents/b.md', '---\nname: B\ndescription: Test.\nmodel: opus\n---\nDo it.');
    const sonnet = loadClaudeCodeDefinition('/agents/c.md', '---\nname: C\ndescription: Test.\nmodel: sonnet\n---\nDo it.');
    const inherit = loadClaudeCodeDefinition('/agents/e.md', '---\nname: E\ndescription: Test.\nmodel: inherit\n---\nDo it.');
    const weird = loadClaudeCodeDefinition('/agents/d.md', '---\nname: D\ndescription: Test.\nmodel: gpt-5\n---\nDo it.');
    expect(haiku.ok && haiku.value.definition.modelPreference).toBe('budget');
    expect(opus.ok && opus.value.definition.modelPreference).toBe('frontier');
    expect(sonnet.ok && sonnet.value.definition.modelPreference).toBe('parent');
    expect(inherit.ok && inherit.value.definition.modelPreference).toBe('parent');
    expect(weird.ok && weird.value.definition.modelPreference).toBe('parent');
    expect(weird.ok && weird.value.warnings.some((w) => w.includes('gpt-5'))).toBe(true);
  });

  it('cc: maxTurns → stepCap', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\nmaxTurns: 12\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.stepCap).toBe(12);
  });

  it('cc: permissionMode → warning, never a failure', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\npermissionMode: bypassPermissions\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain(
      'permissionMode is ignored — helpers ask through the assistant, and approving the hire is the grant',
    );
  });

  it('cc: hooks/skills → warning, never a failure', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\nhooks:\n  pre:\n    command: foo\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain('hooks/skills in this file don’t run for helpers');
  });

  it('cc: color/memory ignored silently', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ncolor: blue\nmemory: something\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.some((w) => w.toLowerCase().includes('color') || w.toLowerCase().includes('memory'))).toBe(false);
  });

  it('cc: missing name → error', () => {
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', '---\ndescription: Test.\n---\nDo the thing.');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('Claude Code agent files need a `name:`');
  });

  it('cc: id is the slug of name', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/some-file-name.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('docs-writer');
  });
});

describe('both loaders', () => {
  it('both: prompt is wrapped in the shared prefix/suffix', () => {
    const sharedPrefix = BUILTIN_SPECIALISTS[0].systemPrompt.split('\n\n')[0];
    const personal = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test.\n---\nDo the thing.');
    const cc = loadClaudeCodeDefinition('/agents/foo.md', '---\nname: Foo\ndescription: Test.\n---\nDo the thing.');
    expect(personal.ok && personal.value.definition.systemPrompt.startsWith(sharedPrefix)).toBe(true);
    expect(cc.ok && cc.value.definition.systemPrompt.startsWith(sharedPrefix)).toBe(true);
  });

  it('both: a 2,000-char description is cut to 300 in the definition, kept whole in fullDescription, and warned', () => {
    const longDescription = 'x'.repeat(2000);
    const raw = `---\ndescription: ${longDescription}\n---\nDo the thing.`;
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.description.length).toBe(300);
    expect(result.value.definition.description.endsWith('…')).toBe(true);
    expect(result.value.fullDescription).toBe(longDescription);
    expect(result.value.warnings).toContain(
      "description shortened to 300 characters for the assistant's tool list — the full text is here",
    );
  });

  it('both: a description exactly at the cap is not cut and carries no fullDescription', () => {
    const exact300 = 'x'.repeat(300);
    const raw = `---\ndescription: ${exact300}\n---\nDo the thing.`;
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.description).toBe(exact300);
    expect(result.value.fullDescription).toBeUndefined();
  });

  it('both: source is stamped', () => {
    const personal = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test.\n---\nDo the thing.');
    const cc = loadClaudeCodeDefinition('/agents/foo.md', '---\nname: Foo\ndescription: Test.\n---\nDo the thing.');
    expect(personal.ok && personal.value.definition.source).toBe('personal');
    expect(cc.ok && cc.value.definition.source).toBe('claude-code');
  });
});

describe('deriveCharter', () => {
  it('is read-write when the tools include Write, Edit, or Bash', () => {
    expect(deriveCharter(['Read', 'Write'])).toBe('read-write');
    expect(deriveCharter(['Read', 'Edit'])).toBe('read-write');
    expect(deriveCharter(['Read', 'Bash'])).toBe('read-write');
  });

  it('is read-only otherwise', () => {
    expect(deriveCharter(['Read', 'Glob', 'Grep'])).toBe('read-only');
    expect(deriveCharter([])).toBe('read-only');
  });
});

describe('slugifyId', () => {
  it('lowercases, replaces non-alphanumerics with dashes, collapses runs, and trims', () => {
    expect(slugifyId('Docs Writer')).toBe('docs-writer');
    expect(slugifyId('  Foo__Bar!!  ')).toBe('foo-bar');
    expect(slugifyId('already-a-slug')).toBe('already-a-slug');
  });
});

describe('STARTER_FILE_CONTENTS', () => {
  it('STARTER_FILE_CONTENTS parses as a valid personal definition with zero warnings', () => {
    const result = loadPersonalDefinition(`/whatever/${STARTER_FILE_NAME}`, STARTER_FILE_CONTENTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([]);
  });

  it('lists tools: explicitly', () => {
    expect(STARTER_FILE_CONTENTS).toMatch(/^tools:/m);
  });
});
