/**
 * GitHub device-flow authentication (main process).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Non-developers can't be expected to open a terminal and run `gh auth login`.
 * This module runs GitHub's OAuth *device flow* directly — the same flow the
 * `gh` CLI uses under the hood — so the app can show a one-time code, poll for
 * approval, and then hand the resulting token to `gh auth login --with-token`.
 * That keeps `gh` as the single credential store the sync layer already relies
 * on (its `.netrc` / `gh repo create|view` machinery keeps working unchanged),
 * while giving us an in-app, non-terminal experience.
 *
 * PURE-CORE / IO-SHELL PATTERN
 * ----------------------------
 * Every function takes its network / process / timer I/O as an INJECTED
 * function with a real default (`fetchFn`, `execFn`, `spawnFn`, `sleepFn`).
 * That's the house pattern: tests drive the state machine deterministically
 * with mocks, and never hit the network or spawn anything. Production callers
 * omit the injected args and get the real adapters.
 *
 * TOKEN HYGIENE (load-bearing)
 * ----------------------------
 * The access token NEVER leaves this process, is NEVER logged, and is NEVER
 * placed into a thrown Error message or over the remote WebSocket. Its only
 * destination is `gh auth login --with-token`'s stdin. `completeLogin` is
 * written so that no failure path can interpolate the token into an error
 * string — a test forces a failure and asserts the token is absent.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolveCommand, detectWinget } from './prerequisite-installer';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The `gh` CLI's own public OAuth client id. Reusing it means the token we mint
 * is indistinguishable from a normal `gh` login — sync's `gh` calls keep
 * working — and we avoid standing up a second OAuth app (a second consent
 * screen + our own secret handling for zero benefit).
 */
export const CLIENT_ID = '178c6fc778ccc68e1d6a';

/** gh's own default scope set. Space-separated per the device-flow spec. */
export const SCOPES = 'repo read:org gist workflow';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// ---------------------------------------------------------------------------
// Injectable I/O types
// ---------------------------------------------------------------------------

/** Runs a command, resolving `{stdout, stderr}` on exit 0 and THROWING otherwise. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Minimal subset of `fetch` we depend on — real `fetch` satisfies it structurally. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Minimal subset of a spawned child process — real `ChildProcess` satisfies it. */
export interface SpawnedProcess {
  stdin: { write(chunk: string): unknown; end(): void } | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: (arg: any) => void): void;
}

export type SpawnFn = (cmd: string, args: string[]) => SpawnedProcess;

/** Resolves after `ms` milliseconds. Injected so tests use fake/no delays. */
export type SleepFn = (ms: number) => Promise<void>;

// ---------------------------------------------------------------------------
// Default (real) adapters
// ---------------------------------------------------------------------------

/**
 * Default exec adapter. `gh`/`winget` are resolved via PATH (never hardcoded)
 * and are real `.exe`s on Windows, so no `.cmd` shell flip is needed (unlike
 * the npm/claude shims in prerequisite-installer). Throws on non-zero exit,
 * which is exactly how `detectGh` reads `gh auth status`'s exit code.
 */
const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(resolveCommand(cmd), args, {
    encoding: 'utf8',
    ...opts,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

// Node 20+ ships a global `fetch` in the Electron main process.
const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

const defaultSpawn: SpawnFn = (cmd, args) =>
  spawn(cmd, args) as unknown as SpawnedProcess;

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// detectGh
// ---------------------------------------------------------------------------

export interface GhStatus {
  installed: boolean;
  authed: boolean;
  login?: string;
}

/**
 * Detect whether `gh` is installed and authenticated.
 *
 * - `gh --version` throwing (ENOENT or otherwise) ⇒ not installed.
 * - `gh auth status` exit 0 ⇒ authenticated; non-zero (throws) ⇒ not.
 * - When authed, `gh api user -q .login` fills the login handle (best-effort).
 *
 * NEVER throws — every branch resolves to a status object so callers (IPC,
 * modal trigger) can treat it as a plain state read.
 */
export async function detectGh(execFn: ExecFn = defaultExec): Promise<GhStatus> {
  // Step 1: is gh even installed?
  try {
    await execFn('gh', ['--version']);
  } catch {
    return { installed: false, authed: false };
  }

  // Step 2: is it authenticated? `gh auth status` exits non-zero when not,
  // which surfaces here as a thrown error.
  let authed = false;
  try {
    await execFn('gh', ['auth', 'status']);
    authed = true;
  } catch {
    authed = false;
  }
  if (!authed) return { installed: true, authed: false };

  // Step 3: best-effort login handle. A failure here must not downgrade the
  // authed:true fact — we just leave `login` undefined.
  let login: string | undefined;
  try {
    const { stdout } = await execFn('gh', ['api', 'user', '-q', '.login']);
    const trimmed = stdout.trim();
    if (trimmed) login = trimmed;
  } catch {
    /* leave login undefined */
  }
  return { installed: true, authed: true, login };
}

// ---------------------------------------------------------------------------
// startDeviceFlow
// ---------------------------------------------------------------------------

export interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Absolute ms epoch when the code expires (now + expires_in*1000). */
  expiresAt: number;
  /** Server-suggested seconds between polls. */
  interval: number;
}

/**
 * Kick off the device flow: POST the device-code endpoint and normalize the
 * response. Throws `Error('network')` on any transport/shape failure so callers
 * have a single typed reason to render.
 */
export async function startDeviceFlow(
  fetchFn: FetchLike = defaultFetch,
): Promise<DeviceFlow> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }).toString(),
    });
  } catch {
    throw new Error('network');
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error('network');
  }
  if (!data || !data.device_code) throw new Error('network');

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    // Convert relative expires_in (seconds) to an absolute deadline so the
    // poll loop can compare against Date.now() without tracking elapsed time.
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    interval: Number(data.interval),
  };
}

// ---------------------------------------------------------------------------
// pollForToken
// ---------------------------------------------------------------------------

export interface PollOptions {
  intervalMs: number;
  expiresAt: number;
  fetchFn?: FetchLike;
  sleepFn?: SleepFn;
  signal?: AbortSignal;
}

/**
 * Poll the token endpoint until the user approves (or the flow fails).
 *
 * Loop: check abort/expiry → sleep(interval) → POST → interpret:
 *   - `authorization_pending`  → normal, keep polling
 *   - `slow_down`              → grow interval by 5s (and honor a returned
 *                                interval), keep polling
 *   - `access_token`           → resolve `{token}`
 *   - `expired_token` / past   → reject Error('expired')
 *   - `access_denied`          → reject Error('denied')
 *   - transport failure        → reject Error('network')
 * An aborted signal rejects Error('cancelled').
 *
 * `sleepFn` is injected so tests advance time without real delays.
 */
export async function pollForToken(
  deviceCode: string,
  opts: PollOptions,
): Promise<{ token: string }> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  let interval = opts.intervalMs;

  for (;;) {
    // Cancelled by the user closing the modal / hitting cancel.
    if (opts.signal?.aborted) throw new Error('cancelled');
    // Whole-flow timeout: the one-time code is only valid until expiresAt.
    if (Date.now() >= opts.expiresAt) throw new Error('expired');

    // Wait the polling interval BEFORE hitting the endpoint — GitHub rejects
    // polls that arrive faster than `interval` with slow_down.
    await sleepFn(interval);

    // Re-check abort after the (possibly long) sleep before spending a request.
    if (opts.signal?.aborted) throw new Error('cancelled');

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: GRANT_TYPE,
        }).toString(),
        signal: opts.signal,
      });
    } catch {
      throw new Error('network');
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error('network');
    }

    // Success is signalled by the presence of an access_token, not an error field.
    if (data && data.access_token) return { token: data.access_token };

    switch (data && data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // Spec: back off by 5s AND respect any larger interval the server returns.
        interval += 5000;
        if (typeof data.interval === 'number') {
          interval = Math.max(interval, data.interval * 1000);
        }
        continue;
      case 'expired_token':
        throw new Error('expired');
      case 'access_denied':
        throw new Error('denied');
      default:
        // Any unrecognized response is treated as a transport-level failure.
        throw new Error('network');
    }
  }
}

// ---------------------------------------------------------------------------
// completeLogin
// ---------------------------------------------------------------------------

/**
 * Hand the token to `gh auth login --with-token`, which reads the token from
 * stdin. Resolves on exit 0, rejects on non-zero.
 *
 * WHY close stdin: `gh` reads its token from stdin until EOF. If we write the
 * token but never call `stdin.end()`, gh blocks forever waiting for more input
 * and this Promise never settles. Closing stdin is mandatory.
 *
 * TOKEN HYGIENE: no branch below interpolates `token` into any Error message.
 * A test forces a non-zero exit and asserts the token is absent from the
 * rejection — do not add the token to any error string here.
 */
export function completeLogin(
  token: string,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      // `gh` is a real .exe (no .cmd shell flip); resolve via PATH, not a
      // hardcoded path, so it works wherever winget/brew/apt placed it.
      child = spawnFn(resolveCommand('gh'), ['auth', 'login', '--with-token']);
    } catch {
      reject(new Error('Failed to start gh auth login'));
      return;
    }

    child.on('error', () => reject(new Error('gh auth login failed to start')));
    child.on('close', (code) => {
      if (code === 0) resolve();
      // Note: the token is deliberately NOT included in this message.
      else reject(new Error(`gh auth login exited with code ${code ?? 'unknown'}`));
    });

    try {
      child.stdin?.write(token + '\n');
      child.stdin?.end(); // CLOSE stdin or gh hangs forever waiting for EOF.
    } catch {
      reject(new Error('Failed to send credential to gh'));
    }
  });
}

// ---------------------------------------------------------------------------
// installGh
// ---------------------------------------------------------------------------

export interface InstallGhResult {
  ok: boolean;
  /** Windows: gh installed but PATH hasn't propagated — user must restart. */
  restartRequired?: boolean;
  error?: string;
  /** Non-Windows: the copy-paste command the user should run themselves. */
  manual?: string;
}

/**
 * Install `gh` where we can (Windows via winget) or tell the user how (mac/linux).
 *
 * Windows: `detectWinget()` first (winget is an MSIX alias that can be absent),
 * then `winget install --id GitHub.cli -e --silent ...`, then re-detect. If gh
 * still isn't found, the binary is on disk but its dir hasn't propagated into
 * THIS process's PATH — the deterministic fix is to quit and reopen the app
 * (same rule as installClaude). We do NOT poll or rebuild PATH: a restart is
 * the only reliable way for the running Electron process to pick up the new
 * PATH entry (Windows updates HKCU; the live process keeps its old env).
 *
 * `detectWingetFn` is injectable so tests exercise both the winget-present and
 * winget-missing branches without touching the real system.
 *
 * `platform` defaults to `process.platform` but is a parameter so tests can
 * drive the win32 / darwin / linux branches directly.
 */
export async function installGh(
  execFn: ExecFn = defaultExec,
  detectWingetFn: () => Promise<{ installed: boolean; error?: string }> = detectWinget,
  platform: NodeJS.Platform = process.platform,
  // Injected like every other I/O dependency in this module (see PURE-CORE /
  // IO-SHELL in the header): the real default downloads + extracts a release
  // archive, so tests MUST be able to substitute it or they'd hit the network.
  installUserLocalFn: () => Promise<{ success: boolean; error?: string }> = async () => {
    const { installGhUserLocal } = await import('./prerequisite-installer');
    return installGhUserLocal();
  },
): Promise<InstallGhResult> {
  if (platform === 'win32') {
    const winget = await detectWingetFn();
    if (!winget.installed) {
      return { ok: false, error: winget.error };
    }
    try {
      await execFn(
        'winget',
        [
          'install',
          '--id',
          'GitHub.cli',
          '-e',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        { timeout: 300000 },
      );
    } catch (err) {
      return { ok: false, error: `winget failed to install GitHub CLI: ${String(err)}` };
    }

    const check = await detectGh(execFn);
    if (!check.installed) {
      return {
        ok: false,
        restartRequired: true,
        error:
          "GitHub CLI was installed but its location has not been added to this app's PATH yet. " +
          'Quit and reopen YouCoded, then try again.',
      };
    }
    return { ok: true };
  }

  // macOS/Linux: install gh into a user-local bin dir (no sudo, no Homebrew).
  // This branch used to punt with a `manual:` one-liner, which dead-ended every
  // non-Windows user of the sync wizard — a stock macOS has neither `gh` nor
  // `brew`, so "brew install gh" was advice they couldn't act on (hit for real
  // 2026-07-20 setting sync up on a fresh macOS install). The `manual:` strings
  // survive as the FALLBACK when the automated install fails.
  if (platform === 'darwin' || platform === 'linux') {
    const result = await installUserLocalFn();
    if (result.success) return { ok: true };
    return {
      ok: false,
      error: result.error,
      manual: platform === 'darwin' ? 'brew install gh' : 'See https://github.com/cli/cli#installation',
    };
  }
  return { ok: false, manual: 'See https://github.com/cli/cli#installation' };
}
