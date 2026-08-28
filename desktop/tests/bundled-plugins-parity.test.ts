import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';

// Both platforms auto-install bundled plugins from their own list. Until now the
// two lists were kept in sync by a comment only — a plugin added to one and not
// the other silently ships on one platform. This is the guard.
const KOTLIN_MIRROR = path.resolve(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'skills', 'BundledPlugins.kt'
);

describe('bundled plugin parity', () => {
  it('the Kotlin mirror exists where the parity comment says it does', () => {
    expect(fs.existsSync(KOTLIN_MIRROR)).toBe(true);
  });

  it('BundledPlugins.kt lists exactly the same ids in the same order', () => {
    const src = fs.readFileSync(KOTLIN_MIRROR, 'utf8');
    const block = src.match(/val\s+IDS\s*=\s*listOf\(([\s\S]*?)\)/);
    expect(block, 'could not find `val IDS = listOf(...)` in BundledPlugins.kt').not.toBeNull();

    const kotlinIds = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(kotlinIds).toEqual([...BUNDLED_PLUGIN_IDS]);
  });

  it('includes chatsearch on both platforms', () => {
    expect([...BUNDLED_PLUGIN_IDS]).toContain('youcoded-chatsearch');
  });

  // Task B5: Android's PluginInstaller/LocalSkillProvider must expose the
  // same reconcile entry points desktop's plugin-installer.ts/skill-provider.ts
  // added in Track B (readPluginVersion, refreshLocalMarketplaceCache,
  // upgradePluginFromLocal, reconcileBundledPlugins) — a bundled-plugin
  // upgrade fix that lands on only one platform is worse than no fix at all.
  it('the Kotlin installer implements the same reconcile entry points', () => {
    const kt = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'skills', f), 'utf8');
    expect(kt('LocalSkillProvider.kt')).toMatch(/fun reconcileBundledPlugins\(/);
    expect(kt('PluginInstaller.kt')).toMatch(/fun upgradeFromLocal\(/);
    expect(kt('PluginInstaller.kt')).toMatch(/fun refreshLocalMarketplaceCache\(/);
    expect(kt('VersionCompare.kt')).toMatch(/fun isNewer\(/);
  });
});
