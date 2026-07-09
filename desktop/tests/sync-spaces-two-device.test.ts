// desktop/tests/sync-spaces-two-device.test.ts
// Spec §15 two-instance matrix, transport+engine layers only (no Electron):
// two ManagedRoots + engines sharing one bare remote must converge.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { ManagedRoots } from '../src/main/sync-spaces/managed-roots';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import { SpaceSyncEngine } from '../src/main/sync-spaces/engine';
import type { SpaceSyncEvent } from '../src/main/sync-spaces/types';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-e2e-')); });
afterEach(() => {
  // Windows releases chokidar/git handles asynchronously after close() —
  // retry the temp-dir removal instead of flaking on EPERM/ENOTEMPTY.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it('laptop → desktop file propagation via engines', async () => {
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);

  const laptop = new ManagedRoots(path.join(tmp, 'laptop'));
  const desktop = new ManagedRoots(path.join(tmp, 'desktop'));
  laptop.ensure(); desktop.ensure();
  laptop.createProject('app'); desktop.createProject('app');
  const [lSpace] = laptop.spaces().filter(s => s.kind === 'project');
  const [dSpace] = desktop.spaces().filter(s => s.kind === 'project');

  const lT = new GitTransport({ deviceName: 'Laptop' });
  const dT = new GitTransport({ deviceName: 'Desktop' });
  const events: SpaceSyncEvent[] = [];
  const lEngine = new SpaceSyncEngine(lT, { debounceMs: 200, pollMs: 0, onEvent: e => events.push(e) });
  const dEngine = new SpaceSyncEngine(dT, { debounceMs: 200, pollMs: 300, onEvent: e => events.push(e) });

  await lEngine.addSpace(lSpace); await lT.setRemote(lSpace, bare);
  await dEngine.addSpace(dSpace); await dT.setRemote(dSpace, bare);

  fs.writeFileSync(path.join(lSpace.root, 'CLAUDE.md'), '# project instructions\n');
  // Laptop watcher debounces → pushes; desktop poll loop pulls.
  await waitFor(() => fs.existsSync(path.join(dSpace.root, 'CLAUDE.md')), 20_000);
  expect(fs.readFileSync(path.join(dSpace.root, 'CLAUDE.md'), 'utf8')).toBe('# project instructions\n');

  await lEngine.stop(); await dEngine.stop();
}, 30_000);

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise(r => setTimeout(r, 250));
  }
}
