import { describe, test, expect, vi } from 'vitest';
import {
  CLIENT_ID,
  SCOPES,
  detectGh,
  startDeviceFlow,
  pollForToken,
  completeLogin,
  installGh,
  type ExecFn,
  type FetchLike,
  type SpawnFn,
  type SpawnedProcess,
} from '../src/main/github-auth';

// ---------------------------------------------------------------------------
// Test helpers
//
// Every function under test takes INJECTED I/O (fetch / exec / spawn / sleep),
// so these tests never hit the network, never spawn a real process, and never
// wait real time. That's the whole point of the pure-core / IO-shell split:
// the state machine is exercised deterministically here, and only the thin
// default adapters touch the outside world in production.
// ---------------------------------------------------------------------------

/** A mock exec that maps `cmd + ' ' + args` → a canned result or throws. */
function makeExec(
  handlers: Record<string, { stdout?: string; stderr?: string } | { throw: unknown }>,
): ExecFn {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const h = handlers[key];
    if (!h) throw new Error(`unexpected exec: ${key}`);
    if ('throw' in h) throw h.throw;
    return { stdout: h.stdout ?? '', stderr: h.stderr ?? '' };
  };
}

/** Build a fetch-like that returns each queued JSON payload in order. */
function makeFetch(payloads: any[]): FetchLike & { calls: any[] } {
  let i = 0;
  const fn: any = async (_url: string, init?: any) => {
    fn.calls.push({ url: _url, init });
    const body = payloads[Math.min(i, payloads.length - 1)];
    i++;
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = [];
  return fn;
}

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  test('client id and scopes match the gh CLI public app', () => {
    expect(CLIENT_ID).toBe('178c6fc778ccc68e1d6a');
    expect(SCOPES).toBe('repo read:org gist workflow');
  });
});

// ---------------------------------------------------------------------------
// detectGh
// ---------------------------------------------------------------------------

describe('detectGh', () => {
  test('gh absent (ENOENT) → installed:false, authed:false', async () => {
    const err: any = new Error('spawn gh ENOENT');
    err.code = 'ENOENT';
    const exec = makeExec({ 'gh --version': { throw: err } });
    const r = await detectGh(exec);
    expect(r).toEqual({ installed: false, authed: false });
  });

  test('gh present but not authed → installed:true, authed:false, no login', async () => {
    const authErr: any = new Error('gh auth status exit 1');
    authErr.code = 1;
    const exec = makeExec({
      'gh --version': { stdout: 'gh version 2.88.0' },
      'gh auth status': { throw: authErr },
    });
    const r = await detectGh(exec);
    expect(r).toEqual({ installed: true, authed: false });
  });

  test('gh authed → login parsed from `gh api user`', async () => {
    const exec = makeExec({
      'gh --version': { stdout: 'gh version 2.88.0' },
      'gh auth status': { stdout: 'Logged in to github.com' },
      'gh api user -q .login': { stdout: 'itsdestin\n' },
    });
    const r = await detectGh(exec);
    expect(r).toEqual({ installed: true, authed: true, login: 'itsdestin' });
  });

  test('authed but login lookup fails → still authed, login undefined', async () => {
    const exec = makeExec({
      'gh --version': { stdout: 'gh version 2.88.0' },
      'gh auth status': { stdout: 'Logged in' },
      'gh api user -q .login': { throw: new Error('api down') },
    });
    const r = await detectGh(exec);
    expect(r).toEqual({ installed: true, authed: true, login: undefined });
  });

  test('never throws', async () => {
    const exec: ExecFn = async () => {
      throw new Error('boom');
    };
    await expect(detectGh(exec)).resolves.toEqual({ installed: false, authed: false });
  });
});

// ---------------------------------------------------------------------------
// startDeviceFlow
// ---------------------------------------------------------------------------

describe('startDeviceFlow', () => {
  test('maps the device-code response and computes expiresAt', async () => {
    const before = Date.now();
    const fetchFn = makeFetch([
      {
        device_code: 'DC123',
        user_code: '8E15-B86D',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    ]);
    const r = await startDeviceFlow(fetchFn);
    expect(r.deviceCode).toBe('DC123');
    expect(r.userCode).toBe('8E15-B86D');
    expect(r.verificationUri).toBe('https://github.com/login/device');
    expect(r.interval).toBe(5);
    // expiresAt ~= now + 900s (allow a small window for test execution time).
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(r.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    // POSTs to the device-code endpoint with client_id + scope in the body.
    const call = fetchFn.calls[0];
    expect(call.url).toContain('/login/device/code');
    expect(call.init.body).toContain(CLIENT_ID);
  });

  test('network failure throws Error("network")', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(startDeviceFlow(fetchFn)).rejects.toThrow('network');
  });
});

// ---------------------------------------------------------------------------
// pollForToken
// ---------------------------------------------------------------------------

describe('pollForToken', () => {
  const future = () => Date.now() + 900_000;

  test('authorization_pending → keeps polling, then resolves on access_token', async () => {
    const fetchFn = makeFetch([
      { error: 'authorization_pending' },
      { access_token: 'gho_secrettoken', token_type: 'bearer', scope: SCOPES },
    ]);
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    const r = await pollForToken('DC123', {
      intervalMs: 5000,
      expiresAt: future(),
      fetchFn,
      sleepFn,
    });
    expect(r).toEqual({ token: 'gho_secrettoken' });
    // Slept once per poll attempt (both at the base interval).
    expect(sleeps).toEqual([5000, 5000]);
  });

  test('slow_down grows the interval by 5s (and honors a returned interval)', async () => {
    const fetchFn = makeFetch([
      { error: 'slow_down', interval: 12 },
      { access_token: 'gho_x' },
    ]);
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    await pollForToken('DC', {
      intervalMs: 5000,
      expiresAt: future(),
      fetchFn,
      sleepFn,
    });
    // First sleep at base 5000; after slow_down interval grows to max(5000+5000, 12000)=12000.
    expect(sleeps).toEqual([5000, 12000]);
  });

  test('expired_token rejects Error("expired")', async () => {
    const fetchFn = makeFetch([{ error: 'expired_token' }]);
    await expect(
      pollForToken('DC', { intervalMs: 1, expiresAt: future(), fetchFn, sleepFn: async () => {} }),
    ).rejects.toThrow('expired');
  });

  test('past expiresAt rejects Error("expired") before hitting the network', async () => {
    const fetchFn = makeFetch([{ access_token: 'should-not-be-reached' }]);
    await expect(
      pollForToken('DC', {
        intervalMs: 1,
        expiresAt: Date.now() - 1, // already expired
        fetchFn,
        sleepFn: async () => {},
      }),
    ).rejects.toThrow('expired');
    expect(fetchFn.calls.length).toBe(0);
  });

  test('access_denied rejects Error("denied")', async () => {
    const fetchFn = makeFetch([{ error: 'access_denied' }]);
    await expect(
      pollForToken('DC', { intervalMs: 1, expiresAt: future(), fetchFn, sleepFn: async () => {} }),
    ).rejects.toThrow('denied');
  });

  test('network error during poll rejects Error("network")', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    await expect(
      pollForToken('DC', { intervalMs: 1, expiresAt: future(), fetchFn, sleepFn: async () => {} }),
    ).rejects.toThrow('network');
  });

  test('aborted signal rejects Error("cancelled")', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = makeFetch([{ access_token: 'nope' }]);
    await expect(
      pollForToken('DC', {
        intervalMs: 1,
        expiresAt: future(),
        fetchFn,
        sleepFn: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(fetchFn.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// completeLogin
// ---------------------------------------------------------------------------

/** A fake child process whose exit code and stdin behavior are scriptable. */
function makeFakeChild(exitCode: number | null) {
  const writes: string[] = [];
  let ended = false;
  const listeners: Record<string, (arg: any) => void> = {};
  const child: SpawnedProcess = {
    stdin: {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
        // Fire close asynchronously once stdin is closed (mirrors gh reading EOF).
        setTimeout(() => listeners['close']?.(exitCode), 0);
      },
    },
    on: (event: string, cb: (arg: any) => void) => {
      listeners[event] = cb;
    },
  };
  return { child, writes, get ended() { return ended; } };
}

describe('completeLogin', () => {
  test('writes token+newline, closes stdin, resolves on exit 0', async () => {
    const fake = makeFakeChild(0);
    const spawnFn: SpawnFn = () => fake.child;
    await expect(completeLogin('gho_realtoken', spawnFn)).resolves.toBeUndefined();
    expect(fake.writes).toEqual(['gho_realtoken\n']);
    expect(fake.ended).toBe(true); // stdin MUST be closed or gh hangs forever
  });

  test('rejects on non-zero exit', async () => {
    const fake = makeFakeChild(1);
    const spawnFn: SpawnFn = () => fake.child;
    await expect(completeLogin('gho_realtoken', spawnFn)).rejects.toThrow();
  });

  test('the token NEVER appears in a thrown error message', async () => {
    const TOKEN = 'gho_supersecret_value_1234567890';
    const fake = makeFakeChild(1);
    const spawnFn: SpawnFn = () => fake.child;
    let caught: Error | null = null;
    try {
      await completeLogin(TOKEN, spawnFn);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain(TOKEN);
    expect(String(caught!.stack ?? '')).not.toContain(TOKEN);
  });

  test('rejects (without leaking token) when spawn errors', async () => {
    const TOKEN = 'gho_secret_on_spawn_error';
    const spawnFn: SpawnFn = () => {
      throw new Error('spawn failed');
    };
    let caught: Error | null = null;
    try {
      await completeLogin(TOKEN, spawnFn);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// installGh
// ---------------------------------------------------------------------------

describe('installGh', () => {
  test('Windows: winget succeeds but gh still not on PATH → restartRequired', async () => {
    const ghMissing: any = new Error('ENOENT');
    ghMissing.code = 'ENOENT';
    const exec = makeExec({
      'winget install --id GitHub.cli -e --silent --accept-package-agreements --accept-source-agreements': {
        stdout: 'installed',
      },
      // Post-install re-detect still fails (PATH not propagated to this process).
      'gh --version': { throw: ghMissing },
    });
    const detectWingetFn = async () => ({ installed: true });
    const r = await installGh(exec, detectWingetFn, 'win32');
    expect(r.ok).toBe(false);
    expect(r.restartRequired).toBe(true);
    expect(r.error).toContain('Quit and reopen');
  });

  test('Windows: winget succeeds and gh detected → ok', async () => {
    const exec = makeExec({
      'winget install --id GitHub.cli -e --silent --accept-package-agreements --accept-source-agreements': {
        stdout: 'installed',
      },
      'gh --version': { stdout: 'gh version 2.88.0' },
      'gh auth status': { throw: new Error('not authed') },
    });
    const detectWingetFn = async () => ({ installed: true });
    const r = await installGh(exec, detectWingetFn, 'win32');
    expect(r).toEqual({ ok: true });
  });

  test('Windows: winget missing → surfaces its error, no ok', async () => {
    const exec = makeExec({}); // should never be called
    const detectWingetFn = async () => ({ installed: false, error: 'winget is missing' });
    const r = await installGh(exec, detectWingetFn, 'win32');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('winget is missing');
  });

  // Behavior CHANGED 2026-07-20: macOS/Linux used to punt with a `manual:`
  // one-liner and never attempt an install. A stock macOS has neither gh nor
  // brew, so that advice was unactionable and dead-ended sync setup. These now
  // pin: attempt the user-local install first, fall back to `manual:` only when
  // it fails. The installer is injected so this never touches the network.
  test('macOS: runs the user-local install and reports success', async () => {
    const exec = makeExec({});
    const r = await installGh(exec, async () => ({ installed: true }), 'darwin', async () => ({
      success: true,
    }));
    expect(r.ok).toBe(true);
  });

  test('macOS: falls back to the manual brew command when the install fails', async () => {
    const exec = makeExec({});
    const r = await installGh(exec, async () => ({ installed: true }), 'darwin', async () => ({
      success: false,
      error: 'download failed',
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('download failed');
    expect(r.manual).toContain('brew install gh');
  });

  test('Linux: runs the user-local install and reports success', async () => {
    const exec = makeExec({});
    const r = await installGh(exec, async () => ({ installed: true }), 'linux', async () => ({
      success: true,
    }));
    expect(r.ok).toBe(true);
  });

  test('Linux: falls back to the manual docs pointer when the install fails', async () => {
    const exec = makeExec({});
    const r = await installGh(exec, async () => ({ installed: true }), 'linux', async () => ({
      success: false,
      error: 'tar failed',
    }));
    expect(r.ok).toBe(false);
    expect(r.manual).toContain('github.com/cli/cli');
  });

  // Guards the network-safety property itself: if someone drops the injected
  // default back to a direct call, this test starts doing real I/O and the
  // reviewer has no signal. Asserting the injected fn is actually consulted
  // keeps the seam honest.
  test('the injected installer is what gets called on non-Windows', async () => {
    const exec = makeExec({});
    let called = 0;
    await installGh(exec, async () => ({ installed: true }), 'darwin', async () => {
      called += 1;
      return { success: true };
    });
    expect(called).toBe(1);
  });
});
