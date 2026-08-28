import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';

const inst = vi.hoisted(() => ({
  installPlugin: vi.fn(), upgradePluginFromLocal: vi.fn(), refreshLocalMarketplaceCache: vi.fn(),
  readPluginVersion: vi.fn(), isPluginInstalled: vi.fn(),
}));
vi.mock('../src/main/plugin-installer', () => inst);
import { LocalSkillProvider } from '../src/main/skill-provider';

const entry = (id: string, version: string) => ({ id, type: 'plugin', version, sourceType: 'local', sourceRef: id, sourceMarketplace: 'youcoded' });

describe('LocalSkillProvider.reconcileBundledPlugins', () => {
  let p: LocalSkillProvider; const versions: Record<string, string> = {};
  beforeEach(() => {
    vi.clearAllMocks(); delete process.env.YOUCODED_PROFILE; delete process.env.YOUCODED_BUNDLED_UPGRADE;
    p = new LocalSkillProvider();
    for (const k of Object.keys(versions)) delete versions[k];
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue(BUNDLED_PLUGIN_IDS.map((id) => entry(id, '1.0.0')));
    vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation((id: string, v: string) => { versions[id] = v; });
    inst.refreshLocalMarketplaceCache.mockResolvedValue({ ok: true, refreshed: true });
    inst.isPluginInstalled.mockReturnValue(true);
    inst.readPluginVersion.mockImplementation((dir: string) => dir.includes('youcoded-marketplace-cache') ? '0.2.0' : '0.1.0');
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'installed' });
    inst.installPlugin.mockResolvedValue({ status: 'installed' });
  });
  it('is a no-op on a dev instance unless overridden', async () => {
    process.env.YOUCODED_PROFILE = 'dev';
    expect((await p.reconcileBundledPlugins()).every((r) => r.action === 'skipped-dev')).toBe(true);
    expect(inst.refreshLocalMarketplaceCache).not.toHaveBeenCalled();
    process.env.YOUCODED_BUNDLED_UPGRADE = '1';
    expect((await p.reconcileBundledPlugins()).some((r) => r.action === 'upgraded')).toBe(true);
  });
  it('upgrades when the cache copy is newer and records the plugin.json version', async () => {
    const r = await p.reconcileBundledPlugins();
    expect(r.find((x) => x.id === 'youcoded-chatsearch')).toMatchObject({ action: 'upgraded', from: '0.1.0', to: '0.2.0' });
    expect(inst.upgradePluginFromLocal).toHaveBeenCalledWith('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
    expect(versions['youcoded-chatsearch']).toBe('0.2.0');
  });
  it('leaves an equal version alone', async () => {
    inst.readPluginVersion.mockReturnValue('0.2.0');
    expect((await p.reconcileBundledPlugins()).every((r) => r.action === 'unchanged')).toBe(true);
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
  });
  it('still compares against the last cache copy when the refresh fails', async () => {
    inst.refreshLocalMarketplaceCache.mockResolvedValue({ ok: false, refreshed: false, error: 'fetch failed: offline' });
    expect((await p.reconcileBundledPlugins()).find((x) => x.id === 'youcoded-chatsearch')?.action).toBe('upgraded');
  });
  it('installs a bundled id that is not installed, refetching the index once when it is absent', async () => {
    inst.isPluginInstalled.mockImplementation((id: string) => id !== 'youcoded-chatsearch');
    const fetchIndex = vi.spyOn(p as any, 'fetchIndex')
      .mockResolvedValueOnce(BUNDLED_PLUGIN_IDS.filter((id) => id !== 'youcoded-chatsearch').map((id) => entry(id, '1.0.0')))
      .mockResolvedValueOnce(BUNDLED_PLUGIN_IDS.map((id) => entry(id, '1.0.0')));
    const invalidate = vi.spyOn(p, 'invalidateCache').mockResolvedValue();
    const r = await p.reconcileBundledPlugins();
    expect(invalidate).toHaveBeenCalledTimes(1); expect(fetchIndex).toHaveBeenCalledTimes(2);
    expect(r.find((x) => x.id === 'youcoded-chatsearch')?.action).toBe('installed');
  });
  it('reports install failures instead of swallowing them', async () => {
    inst.isPluginInstalled.mockReturnValue(false);
    inst.installPlugin.mockResolvedValue({ status: 'failed', error: 'clone failed: boom' });
    expect((await p.reconcileBundledPlugins())[0]).toMatchObject({ action: 'failed', error: 'clone failed: boom' });
  });
  it('ensureBundledPluginsInstalled resolves even when reconcile throws', async () => {
    vi.spyOn(p, 'reconcileBundledPlugins').mockRejectedValue(new Error('network'));
    await expect(p.ensureBundledPluginsInstalled()).resolves.toBeUndefined();
  });
});
