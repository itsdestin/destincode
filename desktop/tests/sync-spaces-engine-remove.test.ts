// desktop/tests/sync-spaces-engine-remove.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceSyncEngine } from '../src/main/sync-spaces/engine';
import type { PullResult, PushResult, SpaceVersion, SyncSpace, SyncTransport } from '../src/main/sync-spaces/types';

// Minimal no-op transport — addSpace calls init(); sync calls pull()+push().
const transport: SyncTransport = {
  async init() {}, async hasRemote() { return false; }, async setRemote() {},
  async pull(): Promise<PullResult> { return { updated: false, conflictCopies: [] }; },
  async push(): Promise<PushResult> { return { pushed: false, oversize: [] }; },
  async history(): Promise<SpaceVersion[]> { return []; },
};

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-eng-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const mkSpace = (id: string): SyncSpace => {
  const root = path.join(tmp, id.replace(/:/g, '_'));
  fs.mkdirSync(root, { recursive: true });
  return { id, kind: id === 'personal' ? 'personal' : 'project', root };
};

describe('SpaceSyncEngine.removeSpace', () => {
  it('removes one live space, leaving others live', async () => {
    const engine = new SpaceSyncEngine(transport, { pollMs: 0, debounceMs: 50, onEvent: () => {} });
    const a = mkSpace('project:a'); const b = mkSpace('project:b');
    await engine.addSpace(a); await engine.addSpace(b);
    expect(engine.liveSpaceIds().sort()).toEqual(['project:a', 'project:b']);
    await engine.removeSpace('project:a');
    expect(engine.liveSpaceIds()).toEqual(['project:b']);
    // Removing an unknown id is a no-op.
    await engine.removeSpace('project:missing');
    expect(engine.liveSpaceIds()).toEqual(['project:b']);
    await engine.stop();
  });
});
