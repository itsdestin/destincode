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
});
