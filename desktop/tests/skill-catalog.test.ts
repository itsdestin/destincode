// The catalog is the ONE place that knows skills live at
// <root>/skills/<name>/SKILL.md. scanSkills() finds them but returns
// `prompt: '/<id>'` — a slash command, not the instructions — and throws the
// directory away, so a native execution path has nothing to load. This closes
// that gap without inventing a second registry.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSkillCatalog, SkillNotFound, SkillUnreadable } from '../src/main/harness/skills/skill-catalog';
import type { SkillEntry } from '../src/shared/types';

function entryFor(id: string, skillDir?: string): SkillEntry {
  return {
    id,
    displayName: id === 'demo' ? 'Demo' : id,
    description: 'A demo skill',
    category: 'other',
    prompt: `/${id}`,
    source: 'plugin',
    type: 'plugin',
    visibility: 'published',
    skillDir,
  } as SkillEntry;
}

function fixture(body: string): SkillEntry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  return entryFor('demo', dir);
}

describe('skill catalog', () => {
  it('loads a skill body from its directory', () => {
    const skill = createSkillCatalog([fixture('---\nname: demo\n---\nStep one. Step two.')]).load('demo');
    expect(skill.body).toContain('Step one');
    expect(skill.displayName).toBe('Demo');
  });

  it('strips frontmatter — the model gets instructions, not YAML', () => {
    const catalog = createSkillCatalog([fixture('---\nname: demo\ndescription: x\n---\nActual instructions.')]);
    expect(catalog.load('demo').body).toBe('Actual instructions.');
  });

  it('leaves a body with no frontmatter alone', () => {
    expect(createSkillCatalog([fixture('Just instructions.')]).load('demo').body).toBe('Just instructions.');
  });

  it('lists id + description for the tool schema, nothing heavier', () => {
    // This rides in the tool description on EVERY turn — a body here would be
    // the exact per-turn cost the capability gate exists to control.
    expect(createSkillCatalog([fixture('---\nname: demo\n---\nbody')]).list())
      .toEqual([{ id: 'demo', description: 'A demo skill' }]);
  });

  it('SkillNotFound names what IS available — a bare "not found" strands the model', () => {
    const catalog = createSkillCatalog([fixture('---\nname: demo\n---\nbody')]);
    let err: unknown;
    try { catalog.load('nope'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SkillNotFound);
    expect((err as SkillNotFound).known).toEqual(['demo']);
    expect((err as SkillNotFound).message).toContain('demo');
  });

  it('an entry with no directory is unreadable, not silently empty', () => {
    // The failure the #177 lesson demands be representable: a skill the UI can
    // see but the harness cannot read must SAY so, not return "".
    expect(() => createSkillCatalog([entryFor('ghost')]).load('ghost')).toThrow(SkillUnreadable);
  });

  it('a directory without SKILL.md is unreadable, and says which path failed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-empty-'));
    let err: unknown;
    try { createSkillCatalog([entryFor('empty', dir)]).load('empty'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SkillUnreadable);
    // Specific and accurate per docs/error-message-standards.md — the real path
    // and the real errno, never a guessed cause.
    expect((err as SkillUnreadable).message).toContain('SKILL.md');
    expect((err as SkillUnreadable).message).toContain('ENOENT');
  });
});
