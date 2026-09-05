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
}

export interface Run {
  runId: string;
  suiteKey: string;
  checkoutId: string;
  status: 'running' | 'passed' | 'failed';
  exitCode: number | null;
  output: string;
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

export const fetchRuns = async (): Promise<Run[]> =>
  (await get<{ runs: Run[] }>('/api/checks/runs')).runs;

/** `fetch` false skips the network hop for a fast first paint; the page then asks
 *  again with the fetch, so a number on screen is never a remembered one passed
 *  off as current. */
export const fetchWorkspace = async (doFetch = true): Promise<WorkspaceState> =>
  get<WorkspaceState>(`/api/workspace${doFetch ? '' : '?fetch=0'}`);

export const runCheck = async (id: string, suite: string, confirmSpend = false): Promise<Run> =>
  (await post<{ run: Run }>('/api/checks/run', { id, suite, confirmSpend })).run;
