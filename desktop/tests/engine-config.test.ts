import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  readEngineConfig, updateEngineConfig, defaultCacheDir, DEFAULT_CONTEXT_SIZE,
} from '../src/main/engine/engine-config';

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

  it('ignores malformed engine values (wrong types) and falls back to defaults', async () => {
    await home.writeJson('config.json', { v: 1, engine: { cacheDir: 42, backend: 'quantum', contextSize: -5 } });
    const cfg = readEngineConfig(home);
    expect(cfg.cacheDir).toBe(defaultCacheDir());
    expect(cfg.backend).toBeNull();
    expect(cfg.contextSize).toBe(DEFAULT_CONTEXT_SIZE);
  });
});
