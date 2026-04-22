import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Hoisted shared state so vi.mock('https') and vi.mock('electron') — which are
// lifted to the top of the file by vitest — can read per-test configuration
// set below. Using vi.doMock per-test with dynamic imports was flaky because
// Node's built-in `https` module resolution races with vitest's mock registry;
// hoisted vi.mock reliably intercepts.
const state = vi.hoisted(() => ({
  appVersion: '0.0.0',
  tmpHome: '',
  httpsMode: 'ok' as 'ok' | 'fail',
  httpsBody: '',
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => state.appVersion,
    getPath: (_name: string) => state.tmpHome,
  },
}));

vi.mock('https', () => ({
  get: vi.fn((_url: string, _opts: any, cb: any) => {
    if (state.httpsMode === 'fail') {
      const req: any = {
        on: (ev: string, fn: Function) => {
          if (ev === 'error') queueMicrotask(() => fn(new Error('ENETUNREACH')));
          return req;
        },
        destroy: () => {},
      };
      return req;
    }
    const handlers: Record<string, Function> = {};
    const res = {
      statusCode: 200,
      headers: {},
      on: (ev: string, fn: Function) => { handlers[ev] = fn; return res; },
    };
    queueMicrotask(() => {
      cb(res);
      handlers['data']?.(Buffer.from(state.httpsBody, 'utf8'));
      handlers['end']?.();
    });
    return { on: () => ({}), destroy: () => {} };
  }),
}));

// Module under test is imported dynamically so we can reset mocks per test.
let serviceModule: typeof import('../changelog-service');

const SAMPLE = `# Changelog

## [1.1.2] — 2026-04-21

### Added
- A new thing.

## [1.1.1] — 2026-04-18

### Fixed
- Something.
`;

function mockElectronApp(version: string) {
  state.appVersion = version;
}

function mockHttpsOk(body: string) {
  state.httpsMode = 'ok';
  state.httpsBody = body;
}

function mockHttpsFail() {
  state.httpsMode = 'fail';
}

beforeEach(async () => {
  state.tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-changelog-test-'));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(state.tmpHome, { recursive: true, force: true });
});

describe('getChangelog', () => {
  it('fetches and writes cache on first call', async () => {
    mockElectronApp('1.1.2');
    mockHttpsOk(SAMPLE);
    serviceModule = await import('../changelog-service');
    const result = await serviceModule.getChangelog({ forceRefresh: false });
    expect(result.fromCache).toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.markdown).toContain('## [1.1.2]');
    const cacheFile = path.join(state.tmpHome, '.claude', '.changelog-cache.json');
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(cached.app_version_at_fetch).toBe('1.1.2');
  });

  it('returns cached data when app version matches and forceRefresh=false', async () => {
    mockElectronApp('1.1.2');
    fs.mkdirSync(path.join(state.tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(state.tmpHome, '.claude', '.changelog-cache.json'), JSON.stringify({
      markdown: SAMPLE,
      entries: [{ version: '1.1.2', date: '2026-04-21', body: 'cached' }],
      fetched_at: '2026-04-21T00:00:00Z',
      app_version_at_fetch: '1.1.2',
    }));
    // https should not be invoked in this test — set fail so a stray call produces an error
    // (but since valid cache wins, the guarantee is "no call at all").
    mockHttpsFail();
    serviceModule = await import('../changelog-service');
    const result = await serviceModule.getChangelog({ forceRefresh: false });
    expect(result.fromCache).toBe(true);
    expect(result.entries[0].body).toBe('cached');
  });

  it('refetches when cache app_version differs from running version', async () => {
    mockElectronApp('1.1.3');
    fs.mkdirSync(path.join(state.tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(state.tmpHome, '.claude', '.changelog-cache.json'), JSON.stringify({
      markdown: '# old', entries: [], fetched_at: '2026-04-01T00:00:00Z', app_version_at_fetch: '1.1.0',
    }));
    mockHttpsOk(SAMPLE);
    serviceModule = await import('../changelog-service');
    const result = await serviceModule.getChangelog({ forceRefresh: false });
    expect(result.fromCache).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  it('refetches even with valid cache when forceRefresh=true', async () => {
    mockElectronApp('1.1.2');
    fs.mkdirSync(path.join(state.tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(state.tmpHome, '.claude', '.changelog-cache.json'), JSON.stringify({
      markdown: '# stale', entries: [], fetched_at: '2026-04-01T00:00:00Z', app_version_at_fetch: '1.1.2',
    }));
    mockHttpsOk(SAMPLE);
    serviceModule = await import('../changelog-service');
    const result = await serviceModule.getChangelog({ forceRefresh: true });
    expect(result.fromCache).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  it('returns stale cache silently on fetch failure', async () => {
    mockElectronApp('1.1.2');
    fs.mkdirSync(path.join(state.tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(state.tmpHome, '.claude', '.changelog-cache.json'), JSON.stringify({
      markdown: SAMPLE, entries: [{ version: '1.1.2', date: '2026-04-21', body: 'cached' }],
      fetched_at: '2026-04-01T00:00:00Z', app_version_at_fetch: '1.1.1',
    }));
    mockHttpsFail();
    serviceModule = await import('../changelog-service');
    const result = await serviceModule.getChangelog({ forceRefresh: true });
    expect(result.fromCache).toBe(true);
    expect(result.error).toBeFalsy();
    expect(result.entries[0].body).toBe('cached');
  });

  it('returns error shape on fetch failure with no cache', async () => {
    mockElectronApp('1.1.2');
    mockHttpsFail();
    serviceModule = await import('../changelog-service');
    const result = await serviceModule.getChangelog({ forceRefresh: true });
    expect(result.error).toBe(true);
    expect(result.markdown).toBeNull();
    expect(result.entries).toEqual([]);
  });
});
