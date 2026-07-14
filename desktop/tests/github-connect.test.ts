import { describe, test, expect, vi } from 'vitest';
import { createGithubConnect, type GithubConnectDeps } from '../src/main/github-connect';

// ---------------------------------------------------------------------------
// The orchestrator drives a DETACHED background chain (poll → login → detect)
// that calls emitDone once. These tests inject fakes for every github-auth step
// so the whole flow runs with no network / no spawn / no real time, and use a
// deferred "done" promise to await the detached chain's single emitDone call.
// ---------------------------------------------------------------------------

type DonePayload = { ok: boolean; login?: string; error?: string };

/** A one-shot barrier: `emit` fulfills `done` with the first emitDone payload. */
function deferredDone() {
  let resolve!: (p: DonePayload) => void;
  const done = new Promise<DonePayload>((r) => { resolve = r; });
  const calls: DonePayload[] = [];
  const emit = (p: DonePayload) => { calls.push(p); resolve(p); };
  return { emit, done, calls };
}

const SECRET = 'gho_supersecrettoken_should_never_leak';

/** Baseline device-flow fake — a code that's valid for 15 minutes. */
const fakeStartDeviceFlow: GithubConnectDeps['startDeviceFlow'] = async () => ({
  deviceCode: 'device-code-123',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresAt: Date.now() + 900_000,
  interval: 5,
});

describe('createGithubConnect', () => {
  test('start() returns the device-flow public render fields', async () => {
    const { emit } = deferredDone();
    // Poll never settles here so we only test the synchronous start() return.
    const neverPoll: GithubConnectDeps['pollForToken'] = () => new Promise(() => {});
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: neverPoll,
    });

    const res = await gc.start();
    expect(res).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: expect.any(Number),
    });
    // The device code (internal) must NOT be exposed in the render fields.
    expect(JSON.stringify(res)).not.toContain('device-code-123');
  });

  test('successful poll + login → emitDone({ok:true, login}) and NEVER the token', async () => {
    const { emit, done } = deferredDone();
    let loginToken: string | undefined;

    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: async () => ({ token: SECRET }),
      completeLogin: async (token) => { loginToken = token; },
      detectGh: async () => ({ installed: true, authed: true, login: 'octocat' }),
    });

    await gc.start();
    const payload = await done;

    // The token flowed ONLY into completeLogin...
    expect(loginToken).toBe(SECRET);
    // ...and the public payload carries the login handle, not the token.
    expect(payload).toEqual({ ok: true, login: 'octocat' });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  test('detectGh failure after login still succeeds (login omitted, never downgrades ok)', async () => {
    const { emit, done } = deferredDone();
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: async () => ({ token: SECRET }),
      completeLogin: async () => {},
      detectGh: async () => { throw new Error('gh api failed'); },
    });

    await gc.start();
    const payload = await done;
    expect(payload).toEqual({ ok: true });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  test("poll rejecting 'expired' → emitDone({ok:false, error:'expired'})", async () => {
    const { emit, done } = deferredDone();
    const completeLogin = vi.fn(async () => {});
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: async () => { throw new Error('expired'); },
      completeLogin,
    });

    await gc.start();
    const payload = await done;
    expect(payload).toEqual({ ok: false, error: 'expired' });
    // A failed poll must never reach completeLogin.
    expect(completeLogin).not.toHaveBeenCalled();
  });

  test("poll rejecting 'denied' maps straight through", async () => {
    const { emit, done } = deferredDone();
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: async () => { throw new Error('denied'); },
    });
    await gc.start();
    expect(await done).toEqual({ ok: false, error: 'denied' });
  });

  test("completeLogin throwing → emitDone({ok:false, error:'login-failed'}) with NO token", async () => {
    const { emit, done } = deferredDone();
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: async () => ({ token: SECRET }),
      // Force a failure whose message even CONTAINS the token — the orchestrator
      // must not propagate it into the done payload.
      completeLogin: async () => { throw new Error(`gh choked on ${SECRET}`); },
    });

    await gc.start();
    const payload = await done;
    expect(payload).toEqual({ ok: false, error: 'login-failed' });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  test("cancel() → poll observes abort → emitDone({ok:false, error:'cancelled'})", async () => {
    const { emit, done } = deferredDone();
    // Realistic poll fake: rejects 'cancelled' when the injected signal aborts.
    const pollForToken: GithubConnectDeps['pollForToken'] = (_dc, opts) =>
      new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) return reject(new Error('cancelled'));
        opts.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
      });

    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken,
    });

    await gc.start();
    gc.cancel();
    expect(await done).toEqual({ ok: false, error: 'cancelled' });
  });

  test('startDeviceFlow throwing rejects start() (no flow to run, no emitDone)', async () => {
    const { emit, calls } = deferredDone();
    const gc = createGithubConnect(emit, {
      startDeviceFlow: async () => { throw new Error('network'); },
    });

    await expect(gc.start()).rejects.toThrow('network');
    // No background chain ran, so emitDone was never called.
    expect(calls).toHaveLength(0);
  });

  test('a superseding start() silences the aborted prior flow (no spurious cancelled, new flow still settles)', async () => {
    // The orchestrator is a singleton shared by desktop + remote. Two starts
    // without an intervening cancel (double-click / racing clients) must not let
    // the aborted first flow emit a 'cancelled' that also blocks the second.
    const { emit, calls } = deferredDone();
    // First flow's poll rejects 'cancelled' the moment its signal aborts.
    const pollA: GithubConnectDeps['pollForToken'] = (_dc, opts) =>
      new Promise((_res, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
      });
    // Second flow succeeds.
    let poll = pollA;
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: (dc, opts) => poll(dc, opts),
      completeLogin: async () => {},
      detectGh: async () => ({ installed: true, authed: true, login: 'octocat' }),
    });

    await gc.start();                 // flow A begins polling
    poll = async () => ({ token: SECRET }); // flow B will succeed
    await gc.start();                 // supersedes A (aborts it)
    // Let A's abort-rejection and B's success both flush.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Exactly ONE emit — flow B's success — and NOT A's spurious 'cancelled'.
    expect(calls).toEqual([{ ok: true, login: 'octocat' }]);
  });

  test('emitDone fires at most once per flow (cancel after success is a no-op)', async () => {
    const { emit, done, calls } = deferredDone();
    const gc = createGithubConnect(emit, {
      startDeviceFlow: fakeStartDeviceFlow,
      pollForToken: async () => ({ token: SECRET }),
      completeLogin: async () => {},
      detectGh: async () => ({ installed: true, authed: true, login: 'octocat' }),
    });

    await gc.start();
    await done;
    gc.cancel(); // late cancel must not emit a second (cancelled) payload
    // Give any stray microtask a chance to run.
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});
