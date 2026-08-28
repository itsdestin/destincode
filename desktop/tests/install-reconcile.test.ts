import { describe, it, expect, vi, beforeEach } from 'vitest';

const listInstalledPluginDirs = vi.fn<[], string[]>();
const postInstalls = vi.fn();

vi.mock('../src/main/claude-code-registry', () => ({ listInstalledPluginDirs: () => listInstalledPluginDirs() }));
vi.mock('../src/renderer/state/marketplace-api-client', () => ({
  MARKETPLACE_API_HOST: 'https://example.invalid',
  createMarketplaceApiClient: () => ({ postInstalls }),
}));

import { installedPluginIds, reconcileInstalls } from '../src/main/install-reconcile';

const store = (token: string | null) => ({ getToken: () => token }) as never;

beforeEach(() => {
  listInstalledPluginDirs.mockReset().mockReturnValue([]);
  postInstalls.mockReset().mockResolvedValue({ ok: true, recorded: 0 });
});

describe('installedPluginIds', () => {
  it('takes the directory name as the id, from BOTH roots', () => {
    listInstalledPluginDirs.mockReturnValue([
      '/home/u/.claude/plugins/marketplaces/youcoded/plugins/civic-report',
      '/home/u/.claude/plugins/youcoded-core',
    ]);
    expect(installedPluginIds()).toEqual(['civic-report', 'youcoded-core']);
  });

  it('deduplicates an id that appears under both roots', () => {
    // listInstalledPluginDirs scans two roots; the pre-decomposition clone can
    // surface the same plugin twice. Sending it twice is harmless but wasteful.
    listInstalledPluginDirs.mockReturnValue(['/a/plugins/dup', '/b/youcoded/dup']);
    expect(installedPluginIds()).toEqual(['dup']);
  });

  it('includes BUNDLED plugins — the whole reason this exists', () => {
    listInstalledPluginDirs.mockReturnValue(['/p/wecoded-themes-plugin', '/p/youcoded-chatsearch']);
    expect(installedPluginIds()).toContain('wecoded-themes-plugin');
  });

  it('drops ids the server would reject, rather than failing the whole batch', () => {
    listInstalledPluginDirs.mockReturnValue([`/p/${'x'.repeat(129)}`, '/p/ok']);
    expect(installedPluginIds()).toEqual(['ok']);
  });
});

describe('reconcileInstalls', () => {
  it('reports every installed id in ONE call', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a', '/p/b', '/p/wecoded-themes-plugin']);
    await reconcileInstalls(store('tok'));
    expect(postInstalls).toHaveBeenCalledTimes(1);
    expect(postInstalls).toHaveBeenCalledWith(['a', 'b', 'wecoded-themes-plugin']);
  });

  it('does nothing when signed out', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a']);
    await reconcileInstalls(store(null));
    expect(postInstalls).not.toHaveBeenCalled();
  });

  it('does not call the server with an empty list', async () => {
    await reconcileInstalls(store('tok'));
    expect(postInstalls).not.toHaveBeenCalled();
  });

  it('NEVER throws — a failure must not break sign-in or startup', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a']);
    postInstalls.mockRejectedValue(new Error('offline'));
    await expect(reconcileInstalls(store('tok'))).resolves.toBeUndefined();
  });

  it('survives the filesystem read itself throwing', async () => {
    listInstalledPluginDirs.mockImplementation(() => { throw new Error('EACCES'); });
    await expect(reconcileInstalls(store('tok'))).resolves.toBeUndefined();
    expect(postInstalls).not.toHaveBeenCalled();
  });

  it('caps the batch at the server limit', async () => {
    listInstalledPluginDirs.mockReturnValue(Array.from({ length: 250 }, (_, i) => `/p/p${i}`));
    await reconcileInstalls(store('tok'));
    expect(postInstalls.mock.calls[0]![0]).toHaveLength(200);
  });
});
