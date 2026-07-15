// desktop/tests/sync-spaces-git-transport.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import type { SyncSpace } from '../src/main/sync-spaces/types';
import { describeTransportContract, TransportHarness } from './sync-transport-contract';

// Real git, local bare repo as the "GitHub" remote. Needs git on PATH (CI has it).
async function makeHarness(): Promise<TransportHarness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-gt-'));
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  let n = 0;
  const transport = new GitTransport({ deviceName: 'TestDevice' });
  return {
    transport,
    async makeDeviceSpace(): Promise<SyncSpace> {
      const root = path.join(tmp, `device-${n++}`);
      fs.mkdirSync(root, { recursive: true });
      const space: SyncSpace = { id: 'project:contract', kind: 'project', root };
      await transport.init(space);
      await transport.setRemote(space, bare);
      return space;
    },
    async cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

describeTransportContract('GitTransport', makeHarness);

describe('GitTransport specifics', () => {
  it('oversize files are excluded from sync and reported', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // 50MB cap — write cap+1 bytes sparsely is slow; instead the transport takes
    // an injectable cap for tests:
    const small = new GitTransport({ deviceName: 'T', maxFileBytes: 10 });
    fs.writeFileSync(path.join(a.root, 'big.bin'), 'x'.repeat(11));
    fs.writeFileSync(path.join(a.root, 'ok.md'), 'fine');
    const r = await small.push(a, 'mixed');
    expect(r.pushed).toBe(true);
    expect(r.oversize).toEqual(['big.bin']);
    await h.cleanup();
  }, 30000);

  it('maybeGc advances the persisted counter and gc runs on the Nth sync without throwing', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Force a gc every 2nd call so we don't need 50 iterations.
    const t = new GitTransport({ deviceName: 'T', gcInterval: 2 });
    const counterFile = path.join(a.root, '.youcoded', 'gc-counter');

    // Give the repo real objects so `git gc` has something to consider.
    fs.writeFileSync(path.join(a.root, 'f.md'), 'v1');
    await t.push(a, 'c1');

    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('1'); // 1 % 2 !== 0, no gc yet
    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('2'); // 2 % 2 === 0, gc ran
    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('3');

    // Corrupt counter file → treated as 0, so next write is 1 (never throws).
    fs.writeFileSync(counterFile, 'not-a-number');
    await expect(t.maybeGc(a)).resolves.toBeUndefined();
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('1');
    await h.cleanup();
  }, 30000);

  it('gitDirSizeBytes returns >0 for a real repo and 0 for a missing dir', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T' });
    fs.writeFileSync(path.join(a.root, 'f.md'), 'content');
    await t.push(a, 'commit');
    const size = await t.gitDirSizeBytes(a);
    expect(size).toBeGreaterThan(0);

    // A space whose .youcoded/sync.git doesn't exist reports 0.
    const empty: SyncSpace = { id: 'project:none', kind: 'project', root: path.join(a.root, 'nope') };
    fs.mkdirSync(empty.root, { recursive: true });
    expect(await t.gitDirSizeBytes(empty)).toBe(0);
    await h.cleanup();
  }, 30000);
});
