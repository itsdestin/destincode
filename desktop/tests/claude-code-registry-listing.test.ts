import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

// Fix (Track B final review, Finding F1): listInstalledPluginDirs()'s
// marketplace-subtree loop used to add EVERY child directory unconditionally
// — no dot-prefix skip, no manifest check — so a stranded `.upgrade-<id>-<pid>`
// or `.old-<id>-<pid>` directory left by a killed mid-swap upgrade got fed
// into hook-reconciler.ts / mcp-reconciler.ts as a second real plugin,
// registering duplicate hooks/MCP servers. These tests pin the fix directly
// against the exported function, mirroring Android's ClaudeCodeRegistry.kt
// hasPluginManifest + dot-skip tests (Task B5 review round 2).

let home: string; let origHome: string | undefined;
const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const pluginsDir = () => path.join(home, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins');
const cacheDir = () => path.join(home, '.claude', 'plugins');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-registry-listing-'));
  origHome = process.env.HOME;
  // WHY: claude-code-registry.ts computes CLAUDE_DIR/YOUCODED_PLUGINS_DIR as
  // module-level consts from os.homedir() at import time, not per-call —
  // without resetModules() every test after the first would read/write
  // against the FIRST test's (already-deleted) tmp home dir.
  process.env.HOME = home; process.env.USERPROFILE = home; vi.resetModules();
});
afterEach(() => {
  process.env.HOME = origHome; delete process.env.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('listInstalledPluginDirs', () => {
  it('ignores a dot-prefixed directory even when it carries a manifest', async () => {
    const { listInstalledPluginDirs } = await import('../src/main/claude-code-registry');
    w(path.join(pluginsDir(), 'real-plugin', 'plugin.json'), '{"name":"real-plugin","version":"1.0.0"}');
    // A stranded staging/retired tree — full copy, manifest included, exactly
    // what a killed-mid-swap upgradePluginFromLocal() leaves behind.
    w(path.join(pluginsDir(), '.upgrade-real-plugin-4242', 'plugin.json'), '{"name":"real-plugin","version":"1.1.0"}');
    w(path.join(pluginsDir(), '.old-real-plugin-4242', 'plugin.json'), '{"name":"real-plugin","version":"1.0.0"}');

    const dirs = listInstalledPluginDirs();
    expect(dirs).toEqual([path.join(pluginsDir(), 'real-plugin')]);
  });

  it('ignores a directory with no plugin.json in either standard location', async () => {
    const { listInstalledPluginDirs } = await import('../src/main/claude-code-registry');
    w(path.join(pluginsDir(), 'real-plugin', 'plugin.json'), '{"name":"real-plugin","version":"1.0.0"}');
    // Not a plugin at all — e.g. a leftover empty dir from some other bug.
    fs.mkdirSync(path.join(pluginsDir(), 'not-a-plugin'), { recursive: true });

    const dirs = listInstalledPluginDirs();
    expect(dirs).toEqual([path.join(pluginsDir(), 'real-plugin')]);
  });

  it('accepts a .claude-plugin/plugin.json manifest layout the same as root plugin.json', async () => {
    const { listInstalledPluginDirs } = await import('../src/main/claude-code-registry');
    w(path.join(pluginsDir(), 'nested-manifest', '.claude-plugin', 'plugin.json'), '{"name":"nested-manifest","version":"1.0.0"}');

    const dirs = listInstalledPluginDirs();
    expect(dirs).toEqual([path.join(pluginsDir(), 'nested-manifest')]);
  });

  it('still walks the top-level toolkit clone alongside the marketplace subtree', async () => {
    const { listInstalledPluginDirs } = await import('../src/main/claude-code-registry');
    w(path.join(cacheDir(), 'youcoded-core', 'plugin.json'), '{"name":"youcoded-core","version":"1.0.0"}');
    w(path.join(pluginsDir(), 'real-plugin', 'plugin.json'), '{"name":"real-plugin","version":"1.0.0"}');
    // known_marketplaces.json / installed_plugins.json / the marketplaces
    // subtree itself must never be mistaken for a plugin.
    w(path.join(cacheDir(), 'installed_plugins.json'), '{}');

    const dirs = listInstalledPluginDirs().sort();
    expect(dirs).toEqual([
      path.join(cacheDir(), 'youcoded-core'),
      path.join(pluginsDir(), 'real-plugin'),
    ].sort());
  });
});
