// G-12 (2026-08-26 tools investigation): the Skill tool accepts optional `args`,
// the way Claude Code's does, so a model can hand a skill what the user said
// ("/theme-builder cozy cabin vibe"). Delivery mirrors Claude Code: `$ARGUMENTS`
// in SKILL.md is substituted; otherwise the args ride a final "Arguments:" line.
import { describe, it, expect } from 'vitest';
import { createSkillTool } from '../src/main/harness/tools/skill';
import type { SkillCatalog } from '../src/main/harness/skills/skill-catalog';

const ctx = { sessionId: 's', cwd: '/tmp', signal: new AbortController().signal, readRegistry: new Map(), todos: [] } as any;

function catalogOf(body: string): SkillCatalog {
  return {
    list: () => [{ id: 'journal', description: 'Write a journal entry' }],
    load: (id: string) => ({ id, displayName: 'Journal', description: 'Write a journal entry', body }),
  };
}

describe('Skill tool `args`', () => {
  it('is an optional string described as pass-through arguments', () => {
    const shape = (createSkillTool(catalogOf('x')).inputSchema as any).shape;
    expect(shape.args).toBeDefined();
    expect(shape.args.description).toMatch(/optional arguments to pass through/i);
  });

  it('substitutes $ARGUMENTS when the skill body uses it', async () => {
    const r = await createSkillTool(catalogOf('Write about: $ARGUMENTS\nThen stop.')).execute({ skill: 'journal', args: 'my trip' } as any, ctx);
    expect(r.text).toContain('Write about: my trip');
    expect(r.text).not.toContain('$ARGUMENTS');
    expect(r.text).not.toMatch(/^Arguments:/m);
  });

  it('appends a final "Arguments:" line when the body has no placeholder', async () => {
    const r = await createSkillTool(catalogOf('1. Open the journal.')).execute({ skill: 'journal', args: 'my trip' } as any, ctx);
    expect(r.text).toMatch(/1\. Open the journal\.\nArguments: my trip\n<\/skill-instructions>$/);
  });

  it('with no args the body is delivered verbatim', async () => {
    const r = await createSkillTool(catalogOf('Do $ARGUMENTS now.')).execute({ skill: 'journal' } as any, ctx);
    expect(r.text).toContain('Do $ARGUMENTS now.');
    expect(r.text).not.toContain('Arguments:');
  });
});
