import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

let home: string; let origHome: string | undefined;
const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const cacheDir = () => path.join(home, '.claude', 'youcoded-marketplace-cache', 'wecoded-marketplace');
const pluginsDir = () => path.join(home, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-upgrade-')); origHome = process.env.HOME;
  process.env.HOME = home; process.env.USERPROFILE = home; vi.resetModules();
});
afterEach(() => { process.env.HOME = origHome; delete process.env.USERPROFILE; fs.rmSync(home, { recursive: true, force: true }); });

describe('plugin-installer upgrade primitives', () => {
  it('readPluginVersion reads root or .claude-plugin manifests', async () => {
    const { readPluginVersion } = await import('../src/main/plugin-installer');
    w(path.join(home, 'a', 'plugin.json'), '{"version":"0.2.0"}');
    w(path.join(home, 'b', '.claude-plugin', 'plugin.json'), '{"version":"3.0.0"}');
    expect(readPluginVersion(path.join(home, 'a'))).toBe('0.2.0');
    expect(readPluginVersion(path.join(home, 'b'))).toBe('3.0.0');
    expect(readPluginVersion(path.join(home, 'c'))).toBeNull();
  });
  it('refreshLocalMarketplaceCache skips the network inside the 1 h gate', async () => {
    const { refreshLocalMarketplaceCache } = await import('../src/main/plugin-installer');
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), '.youcoded-last-pull'), String(Date.now())); // the file setCacheTimestamp writes (:218)
    expect(await refreshLocalMarketplaceCache('youcoded')).toEqual({ ok: true, refreshed: false });
  });
  it('upgradePluginFromLocal swaps the tree and registers the real version', async () => {
    const mod = await import('../src/main/plugin-installer');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.2.0"}');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'skills', 'x', 'SKILL.md'), 'new');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.1.0"}');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'stale.txt'), 'gone after upgrade');
    const r = await mod.upgradePluginFromLocal('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
    expect(r.status).toBe('installed');
    expect(fs.existsSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('new');
    const db = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    expect(db.plugins['youcoded-chatsearch@youcoded'][0].version).toBe('0.2.0');
    expect(fs.readdirSync(pluginsDir()).filter((n) => n.startsWith('.'))).toEqual([]);
  });
  it('upgradePluginFromLocal fails honestly when the cache has no such plugin', async () => {
    const mod = await import('../src/main/plugin-installer');
    fs.mkdirSync(cacheDir(), { recursive: true });
    const r = await mod.upgradePluginFromLocal('nope', 'nope', 'youcoded');
    expect(r.status).toBe('failed'); if (r.status === 'failed') expect(r.error).toMatch(/Source not found in cache: nope/);
  });
});
