// desktop/tests/sync-spaces-managed-roots.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ManagedRoots } from '../src/main/sync-spaces/managed-roots';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-roots-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('ManagedRoots', () => {
  it('ensure() creates Projects and Personal under the base', () => {
    const r = new ManagedRoots(tmp);
    r.ensure();
    expect(fs.existsSync(path.join(tmp, 'YouCoded', 'Projects'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'YouCoded', 'Personal'))).toBe(true);
  });
  it('listProjects() returns directories only, sorted', () => {
    const r = new ManagedRoots(tmp);
    r.ensure();
    fs.mkdirSync(path.join(r.projectsRoot, 'zeta'));
    fs.mkdirSync(path.join(r.projectsRoot, 'alpha'));
    fs.writeFileSync(path.join(r.projectsRoot, 'stray.txt'), 'x');
    expect(r.listProjects().map(p => p.name)).toEqual(['alpha', 'zeta']);
    expect(r.listProjects()[0].path).toBe(path.join(r.projectsRoot, 'alpha'));
  });
  it('createProject() validates the name and rejects duplicates', () => {
    const r = new ManagedRoots(tmp);
    r.ensure();
    expect(r.createProject('my-app')).toEqual({ ok: true, path: path.join(r.projectsRoot, 'my-app') });
    expect(r.createProject('my-app')).toEqual({ ok: false, error: 'A project with that name already exists' });
    const bad = r.createProject('aux');
    expect(bad.ok).toBe(false);
  });
  it('spaces() returns personal + one space per project with stable ids', () => {
    const r = new ManagedRoots(tmp);
    r.ensure();
    r.createProject('my-app');
    const spaces = r.spaces();
    expect(spaces.map(s => s.id)).toEqual(['personal', 'project:my-app']);
    expect(spaces[0].root).toBe(r.personalRoot);
    expect(spaces[1].kind).toBe('project');
  });
});
