// Typed wrappers over the helper's routes.
// Shapes mirror dev-dashboard/checkouts.mjs, instances.mjs and suites.mjs exactly
// — if one changes, change both.

export type Status = 'unsaved' | 'unpushed' | 'pushed' | 'safe';

export interface Checkout {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  dirty: number;
  ahead: number;
  pushed: boolean;
  merged: boolean;
  status: Status;
  missing: boolean;
  isMain: boolean;
}

export interface Instance {
  id: string;
  offset: number;
  profile: string;
  pid: number;
  startedAt: number;
  status: 'starting' | 'running' | 'exited';
  exitCode: number | null;
  error: string | null;
}

export interface RepoState {
  name: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: number;
  blocking: string[];
  fetchFailed: boolean;
  fetchAgeSeconds: number | null;
}

export interface WorkspaceState {
  workspace: RepoState | null;
  repos: RepoState[];
  verdict: { tone: 'ok' | 'warn' | 'stale'; headline: string; detail: string };
}

export interface Suite {
  key: string;
  label: string;
  weight: string;
  paid: boolean;
  does?: string;
  covers?: string;
}

export interface DetailFile {
  file: string;
  kind: string;
  state: string;
  added: number | null;
  removed: number | null;
}

export interface CheckoutDetailData {
  id: string;
  files: DetailFile[];
  byKind: Record<string, DetailFile[]>;
  commits: Array<{ sha: string; subject: string; when: string; author: string }>;
  lastCommitIso: string | null;
  lastCommitRel: string | null;
  pr: { number?: number; title?: string; state?: string; url?: string; isDraft?: boolean; unavailable?: boolean } | null;
  totals: { files: number; added: number; removed: number };
}

/** A union, not a bag of optionals: a backup either happened and has a note, or
 *  it did not and has a reason. Declaring both as always-present was a type that
 *  lied about the value, and every caller had to guess which field was real. */
export type BackupResult =
  | { ok: true; branch: string; sha: string; pushed: boolean; filesBackedUp: number; note: string }
  | { ok: false; error: string };

export interface Run {
  runId: string;
  suiteKey: string;
  checkoutId: string;
  checkoutName?: string;
  checkoutBranch?: string | null;
  command?: string;
  status: 'running' | 'passed' | 'failed';
  exitCode: number | null;
  output: string;
  outputBytes?: number;
  startedAt: number;
  endedAt: number | null;
}

/** Every failure here surfaces the helper's OWN message. Replacing it with a
 *  hardcoded guess is the misleading-error failure docs/error-message-standards.md
 *  forbids — "couldn't reach the server" reads very differently from "no free port
 *  offset", and only one of them is true. */
async function unwrap(res: Response): Promise<any> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  return unwrap(await fetch(path));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return unwrap(await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export const fetchCheckouts = async (): Promise<Checkout[]> =>
  (await get<{ checkouts: Checkout[] }>('/api/checkouts')).checkouts;

export const fetchInstances = async (): Promise<Instance[]> =>
  (await get<{ instances: Instance[] }>('/api/dev/instances')).instances;

export const startInstance = async (id: string): Promise<Instance> =>
  (await post<{ instance: Instance }>('/api/dev/start', { id })).instance;

export const stopInstance = async (id: string): Promise<boolean> =>
  (await post<{ stopped: boolean }>('/api/dev/stop', { id })).stopped;

export const fetchSuites = async (): Promise<Suite[]> =>
  (await get<{ suites: Suite[] }>('/api/suites')).suites;

/** `full` false drops the captured output — sending 512 KB of build log on a
 *  two-second poll is not a status check. The results panel fetches one run whole. */
export const fetchRuns = async (full = false): Promise<{ runs: Run[]; runsDir: string }> =>
  get<{ runs: Run[]; runsDir: string }>(`/api/checks/runs${full ? '' : '?full=0'}`);

/** `fetch` false skips the network hop for a fast first paint; the page then asks
 *  again with the fetch, so a number on screen is never a remembered one passed
 *  off as current. */
export const fetchWorkspace = async (doFetch = true): Promise<WorkspaceState> =>
  get<WorkspaceState>(`/api/workspace${doFetch ? '' : '?fetch=0'}`);

export const fetchDetail = async (id: string): Promise<CheckoutDetailData> =>
  (await get<{ detail: CheckoutDetailData }>(`/api/checkout/${encodeURIComponent(id)}/detail`)).detail;

export const backupCheckout = async (id: string): Promise<BackupResult> =>
  (await post<{ result: BackupResult }>('/api/checkout/backup', { id })).result;

export const fetchRun = async (runId: string): Promise<Run> =>
  (await get<{ run: Run }>(`/api/checks/run/${encodeURIComponent(runId)}`)).run;

export const runCheck = async (id: string, suite: string, confirmSpend = false): Promise<Run> =>
  (await post<{ run: Run }>('/api/checks/run', { id, suite, confirmSpend })).run;
