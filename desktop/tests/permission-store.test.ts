import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PermissionStore } from '../src/main/harness/permission-store';

let home: NativeHome; let store: PermissionStore; let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-store-'));
  home = new NativeHome(dir);           // match NativeHome's real constructor — see native-home.test.ts
  store = new PermissionStore(home);
});

// NativeHome joins '.youcoded' onto the home root; the corrupt-file test seeds
// the JSON directly there (simulating a hand-edited file) to exercise the
// wrong-shape guard without going through the store.
function seedPermissionsFile(contents: string) {
  const ycDir = path.join(dir, '.youcoded');
  fs.mkdirSync(ycDir, { recursive: true });
  fs.writeFileSync(path.join(ycDir, 'permissions.json'), contents, 'utf8');
}

describe('PermissionStore', () => {
  it('returns [] for an unknown project', async () => {
    expect(await store.rulesFor('/some/project')).toEqual([]);
  });
  it('persists a remembered rule per project slug and reads it back', async () => {
    await store.remember('/some/project', { tool: 'Bash', pattern: 'npm test*', action: 'allow' });
    const rules = await store.rulesFor('/some/project');
    // toMatchObject, not toEqual: stored rules also carry a `grantedAt` stamp the
    // permission engine never reads (M5 2a provenance), so an exact-shape
    // assertion here would be asserting the absence of a field on purpose.
    expect(rules).toMatchObject([{ tool: 'Bash', pattern: 'npm test*', action: 'allow' }]);
    expect(rules).toHaveLength(1);
    expect(await store.rulesFor('/other/project')).toEqual([]); // scoped
  });
  it('dedups identical rules', async () => {
    await store.remember('/p', { tool: 'Edit', pattern: 'src/*', action: 'allow' });
    await store.remember('/p', { tool: 'Edit', pattern: 'src/*', action: 'allow' });
    expect((await store.rulesFor('/p')).length).toBe(1);
  });
  it('tolerates a wrong-shape (valid JSON) permissions.json', async () => {
    seedPermissionsFile('{}'); // hand-edited: valid JSON, no projects map
    expect(await store.rulesFor('/p')).toEqual([]);
    await store.remember('/p', { tool: 'Bash', pattern: 'ls*', action: 'allow' });
    expect(await store.rulesFor('/p')).toMatchObject([{ tool: 'Bash', pattern: 'ls*', action: 'allow' }]);
  });

  // ── Management-UI surface (M5 2a): list / remove / removeProject + provenance ──

  it('lists projects with their rules', async () => {
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const projects = await store.list();
    expect(projects).toHaveLength(1);
    expect(projects[0].rules[0].pattern).toBe('ls');
  });

  // The whole reason removal keys by slug: remember() must record the cwd, or the
  // UI has no path to show and no way to get one back from the lossy slug.
  it('records the cwd and a grantedAt timestamp', async () => {
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const [p] = await store.list();
    expect(p.cwd).toBe('/home/d/proj');
    expect(typeof p.rules[0].grantedAt).toBe('string');
  });

  // The trap: remember() rebuilds the entry as { rules }, which drops cwd on the
  // SECOND write to the same project.
  it('preserves the recorded cwd across a later remember', async () => {
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'pwd', action: 'allow' });
    const [p] = await store.list();
    expect(p.cwd).toBe('/home/d/proj');
    expect(p.rules).toHaveLength(2);
  });

  // A repeat approval must NOT look like a fresh grant — the dedupe compares only
  // (tool, pattern, action), so grantedAt stays pinned to the FIRST approval.
  it('does not refresh grantedAt when the same rule is remembered again', async () => {
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const first = (await store.list())[0].rules[0].grantedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const after = await store.list();
    expect(after[0].rules).toHaveLength(1);
    expect(after[0].rules[0].grantedAt).toBe(first);
  });

  it('removes a rule by slug and reports the hit', async () => {
    const rule = { tool: 'Bash', pattern: 'ls', action: 'allow' as const };
    await store.remember('/home/d/proj', rule);
    const [p] = await store.list();
    await expect(store.remove(p.slug, rule)).resolves.toBe(true);
    expect((await store.list())[0]?.rules ?? []).toHaveLength(0);
  });

  it('reports false when nothing matched', async () => {
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const [p] = await store.list();
    await expect(store.remove(p.slug, { tool: 'Bash', pattern: 'nope', action: 'allow' })).resolves.toBe(false);
  });

  // Pre-UI entries have neither cwd nor grantedAt and must still be listable and
  // removable — they are exactly the rules a user most wants to audit.
  it('lists and removes a legacy entry with no cwd', async () => {
    await home.writeJson('permissions.json', { v: 1, projects: { '-legacy': { rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] } } });
    const [p] = await store.list();
    expect(p.slug).toBe('-legacy');
    expect(p.cwd).toBeUndefined();
    await expect(store.remove('-legacy', { tool: 'Bash', pattern: 'ls', action: 'allow' })).resolves.toBe(true);
  });

  it('returns [] for a missing or wrong-shape file', async () => {
    await expect(store.list()).resolves.toEqual([]); // file absent entirely
    await home.writeJson('permissions.json', { projects: null });
    await expect(store.list()).resolves.toEqual([]);
  });

  it('removeProject drops the whole slice', async () => {
    await store.remember('/home/d/proj', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const [p] = await store.list();
    await expect(store.removeProject(p.slug)).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('removeProject reports false for a slug that was never granted', async () => {
    await expect(store.removeProject('-never-granted')).resolves.toBe(false);
  });

  // ── Task 11: specialist-keyed identity (the quad, not the triple) ──────────

  it('does NOT dedupe a specialist-keyed rule against the root session\'s identical rule', async () => {
    // Same (tool, pattern, action) as the root grant below, but scoped to the
    // 'worker' specialist — the FOURTH axis of identity. If dedupe only
    // compared the triple, this would silently vanish into the root grant,
    // which is exactly the widening this task exists to prevent.
    await store.remember('/p', { tool: 'Bash', pattern: 'npm test*', action: 'allow' });
    await store.remember('/p', { tool: 'Bash', pattern: 'npm test*', action: 'allow', specialist: 'worker' });
    const rules = await store.rulesFor('/p');
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.specialist === 'worker')).toMatchObject({ tool: 'Bash', pattern: 'npm test*', action: 'allow' });
    expect(rules.find((r) => r.specialist === undefined)).toMatchObject({ tool: 'Bash', pattern: 'npm test*', action: 'allow' });
  });

  it('dedupes two specialist-keyed rules for the SAME specialist', async () => {
    await store.remember('/p', { tool: 'Bash', pattern: 'ls', action: 'allow', specialist: 'worker' });
    await store.remember('/p', { tool: 'Bash', pattern: 'ls', action: 'allow', specialist: 'worker' });
    expect((await store.rulesFor('/p')).length).toBe(1);
  });

  it('removes only the specialist-keyed rule, leaving the root rule with the same triple intact', async () => {
    await store.remember('/p', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    await store.remember('/p', { tool: 'Bash', pattern: 'ls', action: 'allow', specialist: 'worker' });
    const [p] = await store.list();
    await expect(store.remove(p.slug, { tool: 'Bash', pattern: 'ls', action: 'allow', specialist: 'worker' })).resolves.toBe(true);
    const remaining = (await store.list())[0].rules;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].specialist).toBeUndefined();
  });

  // ── Task 11: file version — the reader accepts v1, every write emits v2 ────

  it('reads rules from a v1 file (no version bump on a pure read)', async () => {
    await home.writeJson('permissions.json', { v: 1, projects: { '-p': { cwd: '/p', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] } } });
    expect(await store.rulesFor('/p')).toMatchObject([{ tool: 'Bash', pattern: 'ls', action: 'allow' }]);
  });

  it('a v1 file on disk round-trips unchanged except the version stamp', async () => {
    const ycDir = path.join(dir, '.youcoded');
    fs.mkdirSync(ycDir, { recursive: true });
    const before = { v: 1, projects: { '-p': { cwd: '/p', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' as const }] } } };
    fs.writeFileSync(path.join(ycDir, 'permissions.json'), JSON.stringify(before), 'utf8');
    // A write that matches NOTHING — the "nothing to remove" branch still goes
    // through mutateJson (every write emits v:2), but must not otherwise touch
    // the existing project/rule data.
    await expect(store.remove('-p', { tool: 'Bash', pattern: 'nope', action: 'allow' })).resolves.toBe(false);
    const after = JSON.parse(fs.readFileSync(path.join(ycDir, 'permissions.json'), 'utf8'));
    expect(after.v).toBe(2);
    expect(after.projects).toEqual(before.projects);
  });

  it('every write stamps v:2, even starting from a missing file', async () => {
    await store.remember('/p', { tool: 'Bash', pattern: 'ls', action: 'allow' });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.youcoded', 'permissions.json'), 'utf8'));
    expect(raw.v).toBe(2);
  });
});
