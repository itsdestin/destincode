/**
 * Connect-GitHub orchestrator (main process).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `github-auth.ts` is a set of pure-ish step functions (start the device flow,
 * poll for a token, hand it to `gh`). This module is the tiny STATEFUL glue that
 * sequences them into the single in-flight "connect" flow the UI drives, and
 * keeps that state out of ipc-handlers.ts so it stays thin AND unit-testable.
 *
 * At most ONE flow runs at a time (a single modal). `start()` returns the public
 * device-flow fields the modal renders (code + URL + expiry) and, in the
 * background, drives poll → login → detect, calling `emitDone` exactly once with
 * a public payload. `cancel()` aborts the in-flight poll.
 *
 * TOKEN HYGIENE (load-bearing)
 * ----------------------------
 * The token returned by `pollForToken` flows ONLY into `completeLogin`. It is
 * NEVER placed into an `emitDone` payload, never logged, never returned. The
 * done payload carries only `login` (a public handle) and a typed `error`
 * reason string. A unit test asserts the token never appears in any emitDone.
 */

import {
  startDeviceFlow as realStartDeviceFlow,
  pollForToken as realPollForToken,
  completeLogin as realCompleteLogin,
  detectGh as realDetectGh,
  type DeviceFlow,
  type GhStatus,
} from './github-auth';

/** Public payload pushed on `github:connect-done`. Never carries the token. */
export interface ConnectDonePayload {
  ok: boolean;
  login?: string;
  /** Typed reason: 'expired' | 'denied' | 'network' | 'cancelled' | 'login-failed'. */
  error?: string;
}

/** Public fields returned by `start()` — exactly what the modal needs to render. */
export interface ConnectStartResult {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

/**
 * Injectable github-auth dependencies. Default to the real implementations;
 * tests pass fakes so the whole flow runs with no network / no spawn.
 */
export interface GithubConnectDeps {
  startDeviceFlow?: typeof realStartDeviceFlow;
  pollForToken?: typeof realPollForToken;
  completeLogin?: typeof realCompleteLogin;
  detectGh?: typeof realDetectGh;
}

export interface GithubConnect {
  /** Begin a flow: returns the modal's render fields and kicks off polling. */
  start(): Promise<ConnectStartResult>;
  /** Abort the in-flight flow (poll rejects 'cancelled' → emitDone). */
  cancel(): void;
}

export function createGithubConnect(
  emitDone: (p: ConnectDonePayload) => void,
  deps: GithubConnectDeps = {},
): GithubConnect {
  const startDeviceFlow = deps.startDeviceFlow ?? realStartDeviceFlow;
  const pollForToken = deps.pollForToken ?? realPollForToken;
  const completeLogin = deps.completeLogin ?? realCompleteLogin;
  const detectGh = deps.detectGh ?? realDetectGh;

  // The single in-flight flow's abort handle. Non-null only while a flow runs.
  let controller: AbortController | null = null;
  // Guard so a late failure after cancel (or any double-settle) can't fire
  // emitDone twice for one flow.
  let settled = false;

  const finish = (p: ConnectDonePayload) => {
    if (settled) return;
    settled = true;
    controller = null;
    emitDone(p);
  };

  async function start(): Promise<ConnectStartResult> {
    // A new flow supersedes any prior one — abort it so its poll can't also
    // settle. (start() is the modal opening; there should be at most one.)
    controller?.abort();
    controller = new AbortController();
    settled = false;

    // startDeviceFlow throws Error('network') — let it reject start() so the
    // modal shows the network-error state immediately (no flow to run).
    let flow: DeviceFlow;
    try {
      flow = await startDeviceFlow();
    } catch (err) {
      controller = null;
      throw err;
    }

    const signal = controller.signal;

    // Detached background chain: poll → login → detect → emitDone. We do NOT
    // await this; start() returns the render fields immediately. Any throw maps
    // to a typed done payload. The token lives only inside this closure.
    void (async () => {
      let token: string;
      try {
        const result = await pollForToken(flow.deviceCode, {
          intervalMs: flow.interval * 1000,
          expiresAt: flow.expiresAt,
          signal,
        });
        token = result.token;
      } catch (err) {
        // pollForToken rejects Error('expired'|'denied'|'network'|'cancelled') —
        // map the reason straight through.
        finish({ ok: false, error: reasonOf(err) });
        return;
      }

      // A completeLogin failure is its own typed reason so the modal can tell
      // "you never approved" apart from "gh choked on the token".
      try {
        await completeLogin(token);
      } catch {
        finish({ ok: false, error: 'login-failed' });
        return;
      }

      // Best-effort: fetch the login handle for the success payload. A detect
      // failure must NOT downgrade the success — we just omit `login`.
      let login: string | undefined;
      try {
        const status: GhStatus = await detectGh();
        if (status.login) login = status.login;
      } catch {
        /* leave login undefined */
      }
      finish({ ok: true, login });
    })();

    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresAt: flow.expiresAt,
    };
  }

  function cancel(): void {
    // Aborting makes the in-flight poll reject Error('cancelled'), which routes
    // through finish({ok:false, error:'cancelled'}). If no flow is running this
    // is a harmless no-op.
    controller?.abort();
  }

  return { start, cancel };
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------
//
// ipc-handlers.ts creates the ONE orchestrator (its emitDone fans the done
// event out to both Electron windows and remote clients) and registers it here.
// remote-server.ts reads it so a remote browser's connect-start/cancel drives
// the SAME in-flight flow — matching how the syncspaces:* rows share a single
// service singleton. Without this, a remote-started flow and a desktop-started
// flow would be two independent orchestrators and cancel would miss.

let singleton: GithubConnect | null = null;

/** Register the process-wide orchestrator (called once from ipc-handlers). */
export function setGithubConnect(gc: GithubConnect): void {
  singleton = gc;
}

/** Read the process-wide orchestrator (remote-server uses this). */
export function getGithubConnect(): GithubConnect | null {
  return singleton;
}

/** Map a thrown value to its typed reason string, defaulting to 'network'. */
function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'expired' || msg === 'denied' || msg === 'cancelled' || msg === 'network') {
    return msg;
  }
  return 'network';
}
