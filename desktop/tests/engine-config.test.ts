import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  readEngineConfig, updateEngineConfig, defaultCacheDir, DEFAULT_CONTEXT_SIZE,
} from '../src/main/engine/engine-config';
import type { EngineBackend } from '../src/shared/engine-types';

// Every backend the app can install, spelled out as an exhaustive Record so
// that ADDING one to EngineBackend and forgetting engine-config's allowlist
// fails to COMPILE here. Without the allowlist entry the save succeeds and
// reads back as null, and the user's chosen backend silently reverts to the
// platform default on the next launch — a bug with no error message anywhere.
const EVERY_BACKEND: Record<EngineBackend, true> = {
  vulkan: true, cpu: true, metal: true, cuda: true, rocm: true,
};

let root: string;
let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-config-'));
  home = new NativeHome(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('engine-config', () => {
  it('returns platform defaults when config.json is absent', () => {
    const cfg = readEngineConfig(home);
    expect(cfg.cacheDir).toBe(defaultCacheDir());
    expect(cfg.backend).toBeNull();
    expect(cfg.contextSize).toBe(DEFAULT_CONTEXT_SIZE);
  });

  it('round-trips a partial update without touching other config.json keys', async () => {
    await home.writeJson('config.json', { v: 1, somethingElse: { keep: true } });
    await updateEngineConfig(home, { backend: 'cpu' });
    const cfg = readEngineConfig(home);
    expect(cfg.backend).toBe('cpu');
    expect(cfg.cacheDir).toBe(defaultCacheDir()); // untouched fields stay default
    const raw = home.readJson('config.json') as any;
    expect(raw.somethingElse).toEqual({ keep: true }); // sibling keys survive
  });

  it('round-trips every backend the app can install, ROCm included', async () => {
    for (const backend of Object.keys(EVERY_BACKEND) as EngineBackend[]) {
      await updateEngineConfig(home, { backend });
      expect(readEngineConfig(home).backend).toBe(backend);
    }
  });

  it('ignores malformed engine values (wrong types) and falls back to defaults', async () => {
    await home.writeJson('config.json', { v: 1, engine: { cacheDir: 42, backend: 'quantum', contextSize: -5 } });
    const cfg = readEngineConfig(home);
    expect(cfg.cacheDir).toBe(defaultCacheDir());
    expect(cfg.backend).toBeNull();
    expect(cfg.contextSize).toBe(DEFAULT_CONTEXT_SIZE);
  });
});
