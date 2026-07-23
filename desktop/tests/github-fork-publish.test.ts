import { describe, it, expect, vi } from 'vitest';
import { forkPublish, extractPRNumber, type ForkPublishArgs } from '../src/main/github-fork-publish';

// ---------------------------------------------------------------------------
// The pipeline is driven entirely through a FAKE GithubClient — no gh, no
// network, no token in sight (the client owns token handling; this module
// never sees it, which is the hygiene-by-construction property).
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; body?: any };

/** Scripted fake client: route(method, path) → response; records every call. */
function fakeClient(route: (method: string, path: string, call: number) => { status: number; json?: any }) {
  const calls: Call[] = [];
  let n = 0;
  return {
    calls,
    client: {
      fetchAuthedLogin: async () => 'octocat',
      api: async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        const res = route(method, path, n++);
        return { status: res.status, json: res.json ?? {} };
      },
    } as any,
  };
}

const FILES = [{ repoPath: 'themes/sunset/manifest.json', contentBase64: 'eyJ9' }];

function baseArgs(client: any, extra: Partial<ForkPublishArgs> = {}): ForkPublishArgs {
  return {
    upstreamRepo: 'itsdestin/wecoded-themes',
    branchName: 'theme/sunset',
    files: FILES,
    prTitle: '[Theme] Sunset',
    prBody: (username) => `by ${username}`,
    client,
    sleepFn: async () => {},
    ...extra,
  };
}

/** Happy-path router: fork 202, ref 200, branch 201, PUT 201, PR 201. */
function happyRoute(method: string, path: string): { status: number; json?: any } {
  if (method === 'POST' && path.endsWith('/forks')) return { status: 202 };
  if (method === 'GET' && path.includes('/git/ref/')) return { status: 200, json: { object: { sha: 'abc123' } } };
  if (method === 'POST' && path.endsWith('/git/refs')) return { status: 201 };
  if (method === 'PUT' && path.includes('/contents/')) return { status: 201 };
  if (method === 'POST' && path.endsWith('/pulls')) return { status: 201, json: { html_url: 'https://github.com/itsdestin/wecoded-themes/pull/9', number: 9 } };
  return { status: 500 };
}

describe('forkPublish', () => {
  it('happy path: fork → branch from upstream head → upload → PR, body built with the authed login', async () => {
    const { client, calls } = fakeClient(happyRoute);
    const result = await forkPublish(baseArgs(client));
    expect(result).toEqual({ prUrl: 'https://github.com/itsdestin/wecoded-themes/pull/9', prNumber: 9, username: 'octocat' });

    // Fork is created on upstream; branch + contents land on the FORK; the PR
    // goes back to upstream with the cross-repo head.
    expect(calls.find(c => c.path === '/repos/itsdestin/wecoded-themes/forks')).toBeTruthy();
    const refCreate = calls.find(c => c.method === 'POST' && c.path.endsWith('/git/refs'))!;
    expect(refCreate.path).toContain('/repos/octocat/wecoded-themes/');
    expect(refCreate.body).toEqual({ ref: 'refs/heads/theme/sunset', sha: 'abc123' });
    const put = calls.find(c => c.method === 'PUT')!;
    expect(put.path).toBe('/repos/octocat/wecoded-themes/contents/themes/sunset/manifest.json');
    expect(put.body.branch).toBe('theme/sunset');
    const pr = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect(pr.body.head).toBe('octocat:theme/sunset');
    expect(pr.body.base).toBe('main');
    expect(pr.body.body).toBe('by octocat');
  });

  it('FORK-MATERIALIZING PIN: 404 on branch creation retries until the fork exists', async () => {
    let refAttempts = 0;
    const { client } = fakeClient((method, path) => {
      if (method === 'POST' && path.endsWith('/git/refs')) {
        refAttempts++;
        return refAttempts < 3 ? { status: 404 } : { status: 201 };
      }
      return happyRoute(method, path);
    });
    const result = await forkPublish(baseArgs(client));
    expect(refAttempts).toBe(3);
    expect(result.prNumber).toBe(9);
  });

  it('branch already exists (422) → force-reset to upstream head, publish continues', async () => {
    const { client, calls } = fakeClient((method, path) => {
      if (method === 'POST' && path.endsWith('/git/refs')) return { status: 422 };
      if (method === 'PATCH') return { status: 200 };
      return happyRoute(method, path);
    });
    await forkPublish(baseArgs(client));
    const patch = calls.find(c => c.method === 'PATCH')!;
    expect(patch.path).toBe('/repos/octocat/wecoded-themes/git/refs/heads/theme/sunset');
    expect(patch.body).toEqual({ sha: 'abc123', force: true });
  });

  it('file already on the branch → sha lookup then update PUT', async () => {
    let puts = 0;
    const { client, calls } = fakeClient((method, path) => {
      if (method === 'PUT') { puts++; return puts === 1 ? { status: 422 } : { status: 200 }; }
      if (method === 'GET' && path.includes('/contents/')) return { status: 200, json: { sha: 'oldsha' } };
      return happyRoute(method, path);
    });
    await forkPublish(baseArgs(client));
    const secondPut = calls.filter(c => c.method === 'PUT')[1];
    expect(secondPut.body.sha).toBe('oldsha');
  });

  it('PR already open (422) → returns the existing PR (success, not failure)', async () => {
    const { client } = fakeClient((method, path) => {
      if (method === 'POST' && path.endsWith('/pulls')) return { status: 422, json: { message: 'A pull request already exists' } };
      if (method === 'GET' && path.includes('/pulls?head=')) {
        return { status: 200, json: [{ html_url: 'https://github.com/itsdestin/wecoded-themes/pull/7', number: 7 }] };
      }
      return happyRoute(method, path);
    });
    const result = await forkPublish(baseArgs(client));
    expect(result.prUrl).toContain('/pull/7');
    expect(result.prNumber).toBe(7);
  });

  it('exhausted fork-readiness retries → plain-language "fork still being created" error', async () => {
    const { client } = fakeClient((method, path) => {
      if (method === 'POST' && path.endsWith('/git/refs')) return { status: 404 };
      return happyRoute(method, path);
    });
    await expect(forkPublish(baseArgs(client))).rejects.toThrow('still being created');
  });

  it('no client registered → plain-language "Not connected to GitHub" error', async () => {
    await expect(forkPublish(baseArgs(null))).rejects.toThrow('Not connected to GitHub');
  });

  it('upstream unreadable → error names the repo and suggests checking the connection', async () => {
    const { client } = fakeClient((method, path) => {
      if (method === 'GET' && path.includes('/git/ref/')) return { status: 404, json: {} };
      return happyRoute(method, path);
    });
    await expect(forkPublish(baseArgs(client))).rejects.toThrow('Could not read itsdestin/wecoded-themes');
  });
});

describe('extractPRNumber', () => {
  it('parses /pull/<n> and degrades to 0 on junk', () => {
    expect(extractPRNumber('https://github.com/a/b/pull/123')).toBe(123);
    expect(extractPRNumber('nonsense')).toBe(0);
  });
});
