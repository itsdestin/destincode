import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanProjectSkills, scanSkills } from '../src/main/skill-scanner';

describe('scanSkills', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-skill-scan-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); }
  function write(p: string, content: string) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }

  it('returns empty list when ~/.claude/plugins/ and ~/.claude/skills/ are empty', () => {
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    expect(scanSkills()).toEqual([]);
  });

  it('does NOT inject curated-registry entries that aren\'t present on disk', () => {
    // This is the regression test for the "every curated skill shows Installed"
    // bug. Before the fix, scanSkills() appended every curated id unconditionally.
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    const ids = scanSkills().map((s: any) => s.id);
    expect(ids).not.toContain('encyclopedia');
    expect(ids).not.toContain('food');
    expect(ids).not.toContain('inbox');
  });

  it('discovers a plugin with a plugin.json and skills/ subdir', () => {
    // Seed as a generic marketplace plugin (non-youcoded-prefixed name so source
    // resolves to 'plugin', not the legacy 'youcoded-core' branch).
    const root = path.join(tmpHome, '.claude', 'plugins', 'test-plugin');
    write(path.join(root, 'plugin.json'), '{"name":"test-plugin"}');
    mkdir(path.join(root, 'skills', 'setup-wizard'));
    mkdir(path.join(root, 'skills', 'remote-setup'));

    const skills = scanSkills();
    const ids = skills.map((s: any) => s.id).sort();
    // Non-youcoded plugins get namespaced ids: <plugin>:<skill>
    expect(ids).toEqual(['test-plugin:remote-setup', 'test-plugin:setup-wizard']);
    expect(skills.every((s: any) => s.source === 'plugin')).toBe(true);
  });

  it('discovers a project skill from its .claude/skills directory', () => {
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-project-skill-'));
    try {
      write(path.join(project, '.claude', 'skills', 'wrap-up', 'SKILL.md'),
        '---\nname: Wrap up\ndescription: Improve this workspace\n---\n\nInstructions\n');

      expect(scanProjectSkills(project)).toContainEqual(expect.objectContaining({
        id: 'wrap-up', source: 'project', visibility: 'private',
        displayName: 'Wrap up', description: 'Improve this workspace',
        skillDir: path.join(project, '.claude', 'skills', 'wrap-up'),
      }));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('tags user-authored skills under ~/.claude/skills/ with source:"self"', () => {
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    const userSkill = path.join(tmpHome, '.claude', 'skills', 'my-custom-skill');
    write(path.join(userSkill, 'SKILL.md'),
      '---\nname: My Custom Skill\ndescription: Does the thing\n---\n\nBody\n');

    const skills = scanSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'my-custom-skill',
      source: 'self',
      visibility: 'private',
      displayName: 'My Custom Skill',
      description: 'Does the thing',
    });
  });

});
