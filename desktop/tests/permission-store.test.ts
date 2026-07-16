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
    expect(rules).toEqual([{ tool: 'Bash', pattern: 'npm test*', action: 'allow' }]);
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
    expect(await store.rulesFor('/p')).toEqual([{ tool: 'Bash', pattern: 'ls*', action: 'allow' }]);
  });
});
