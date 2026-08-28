import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';

const inst = vi.hoisted(() => ({
  installPlugin: vi.fn(), upgradePluginFromLocal: vi.fn(), refreshLocalMarketplaceCache: vi.fn(),
  readPluginVersion: vi.fn(), isPluginInstalled: vi.fn(),
  // Review fix (Finding 2): skill-provider.ts now imports marketplaceCacheDir
  // from plugin-installer instead of hand-building the cache path. Mirror the
  // real helper's shape (contains 'youcoded-marketplace-cache' + the source
  // ref) so the readPluginVersion mock below — which switches on that
  // substring — still tells an installed-tree read from a cache-clone read.
  marketplaceCacheDir: vi.fn((mp: string, sourceRef: string) => `/home/test/.claude/youcoded-marketplace-cache/${mp}/${sourceRef}`),
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
    // Review fix (Finding 3): the missing-id refetch now clears only the
    // index cache (invalidateIndexCache), not the broad invalidateCache —
    // which also wipes the marketplace's featured-rail and curated-defaults
    // caches. Assert the narrow method fires once, and the broad one never does.
    const invalidateIndex = vi.spyOn(p, 'invalidateIndexCache').mockResolvedValue();
    const invalidateBroad = vi.spyOn(p, 'invalidateCache').mockResolvedValue();
    const r = await p.reconcileBundledPlugins();
    expect(invalidateIndex).toHaveBeenCalledTimes(1);
    expect(invalidateBroad).not.toHaveBeenCalled();
    expect(fetchIndex).toHaveBeenCalledTimes(2);
    expect(r.find((x) => x.id === 'youcoded-chatsearch')?.action).toBe('installed');
  });
  it('refetches the missing-index at most once per process, even across two reconcile calls', async () => {
    // Review fix (Finding 3): a bundled id that is PERMANENTLY missing from
    // the index (its marketplace entry hasn't merged yet) must not
    // re-invalidate on every call in this process — only the first.
    inst.isPluginInstalled.mockImplementation((id: string) => id !== 'youcoded-chatsearch');
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue(
      BUNDLED_PLUGIN_IDS.filter((id) => id !== 'youcoded-chatsearch').map((id) => entry(id, '1.0.0')),
    );
    const invalidateIndex = vi.spyOn(p, 'invalidateIndexCache').mockResolvedValue();
    await p.reconcileBundledPlugins();
    await p.reconcileBundledPlugins();
    expect(invalidateIndex).toHaveBeenCalledTimes(1);
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

// Review fix (Finding 4): update() had zero test coverage — Finding 1 (a
// missing via check that could create a duplicate install) is exactly the
// kind of bug that gap let through.
describe('LocalSkillProvider.update', () => {
  let p: LocalSkillProvider;
  const versions: Record<string, string> = {};
  beforeEach(() => {
    vi.clearAllMocks();
    p = new LocalSkillProvider();
    for (const k of Object.keys(versions)) delete versions[k];
    vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation((id: string, v: string) => { versions[id] = v; });
    inst.readPluginVersion.mockReturnValue('2.0.0');
  });

  it('replaces the tree and records the disk version when already_installed via YouCoded on a local source', async () => {
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'installed' });
    const r = await p.update('youcoded-chatsearch');
    expect(inst.upgradePluginFromLocal).toHaveBeenCalledWith('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
    expect(r).toMatchObject({ ok: true, newVersion: '2.0.0' });
    expect(versions['youcoded-chatsearch']).toBe('2.0.0');
  });

  it('does not call upgradePluginFromLocal for a url-sourced plugin', async () => {
    const urlEntry = { id: 'ext-plugin', type: 'plugin', version: '1.0.0', sourceType: 'url', sourceRef: 'https://example.com/ext.git', sourceMarketplace: 'youcoded' };
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([urlEntry]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    const r = await p.update('ext-plugin');
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('does not call upgradePluginFromLocal for a git-subdir-sourced plugin', async () => {
    const subdirEntry = { id: 'ext-plugin', type: 'plugin', version: '1.0.0', sourceType: 'git-subdir', sourceRef: 'https://example.com/ext.git', sourceSubdir: 'sub', sourceMarketplace: 'youcoded' };
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([subdirEntry]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    const r = await p.update('ext-plugin');
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('reports a failure, not success, when the plugin is installed via Claude Code', async () => {
    // Finding 1: this is the regression itself — installPlugin's local-source
    // branch would otherwise fall through and write a SECOND copy under
    // YOUCODED_PLUGINS_DIR for an id Claude Code already owns.
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'Claude Code' });
    const r = await p.update('youcoded-chatsearch');
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Claude Code/);
    expect(p.configStore.updatePackageVersion).not.toHaveBeenCalled();
  });

  it('returns a failure without bumping the recorded version when the upgrade fails', async () => {
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'failed', error: 'disk full' });
    const r = await p.update('youcoded-chatsearch');
    expect(r).toMatchObject({ ok: false, error: 'disk full' });
    expect(p.configStore.updatePackageVersion).not.toHaveBeenCalled();
  });

  it('records the version read off disk, not the marketplace index version', async () => {
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'installed' });
    inst.readPluginVersion.mockReturnValue('1.5.2');
    const r = await p.update('youcoded-chatsearch');
    expect(r.newVersion).toBe('1.5.2');
    expect(versions['youcoded-chatsearch']).toBe('1.5.2');
  });
});
