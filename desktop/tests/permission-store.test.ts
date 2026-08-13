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
});
