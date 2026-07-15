import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CuratedCatalog } from '../src/main/models/curated-catalog';
import { SHIPPED_CURATED } from '../src/main/models/curated-models';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curated-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const remoteList = [{
  id: 'remote-model', label: 'Remote Model', tier: 'large', hfRepo: 'unsloth/Remote-GGUF',
  quantDefault: 'Q4_K_M',
}];
const okFetch = (async () => ({
  ok: true, json: async () => ({ schemaVersion: 1, models: remoteList }),
})) as any;
const deadFetch = (async () => { throw new Error('offline'); }) as any;

describe('CuratedCatalog', () => {
  it('serves the remote list when the fetch succeeds, and caches it', async () => {
    const cat = new CuratedCatalog(dir, okFetch);
    expect(await cat.get()).toEqual(remoteList);
    // Second instance with a dead network serves the disk cache.
    const offline = new CuratedCatalog(dir, deadFetch);
    expect(await offline.get()).toEqual(remoteList);
  });

  it('falls back to the SHIPPED copy when fetch fails and no cache exists', async () => {
    const cat = new CuratedCatalog(dir, deadFetch);
    expect(await cat.get()).toEqual(SHIPPED_CURATED);
  });

  it('rejects malformed remote payloads (wrong schemaVersion / non-array) → shipped copy', async () => {
    const badFetch = (async () => ({ ok: true, json: async () => ({ schemaVersion: 99, models: 'nope' }) })) as any;
    const cat = new CuratedCatalog(dir, badFetch);
    expect(await cat.get()).toEqual(SHIPPED_CURATED);
  });
});
