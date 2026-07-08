// desktop/src/main/sync-spaces/space-manager.ts
// Sync enable/disable state + per-space GitHub remote provisioning.
// State lives at ~/.claude/toolkit-state/sync-spaces.json.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SyncSpace } from './types';

const execFileAsync = promisify(execFile);

export function repoNameForSpace(space: SyncSpace): string {
  if (space.kind === 'personal') return 'youcoded-sync-personal';
  const name = space.id.replace(/^project:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `youcoded-sync-project-${name}`;
}

/** Creates a private repo via gh and returns its clone URL. Mirrors the
 *  createGithubRepo pattern in sync-setup-handlers.ts. An ALREADY-EXISTING
 *  repo is success, not failure — the state file recording provisioned URLs
 *  is per-device, so the user's second device re-runs this for repos the
 *  first device already created. Without the recovery path, sync could
 *  never start on any device but the first. */
export async function provisionGithubRemote(repoName: string): Promise<string> {
  try {
    // `gh repo create` prints the repo URL on success; --private is mandatory (spec §14).
    const { stdout } = await execFileAsync('gh', ['repo', 'create', repoName, '--private'], { timeout: 60_000 });
    const url = stdout.trim();
    if (!/^https:\/\/github\.com\//.test(url)) throw new Error(`unexpected gh output: ${stdout}`);
    return `${url}.git`;
  } catch (e: any) {
    // Recovery: if the repo already exists (created by another device), reuse it.
    const view = await execFileAsync('gh', ['repo', 'view', repoName, '--json', 'url', '-q', '.url'], { timeout: 60_000 })
      .catch(() => null);
    const url = view?.stdout.trim();
    if (url && /^https:\/\/github\.com\//.test(url)) return `${url}.git`;
    throw e; // genuinely failed (offline, not authed, invalid name) — surface the original error
  }
}

interface SpaceManagerOpts {
  stateFile?: string; // injectable for tests
  provisionRemote?: (repoName: string) => Promise<string>;
}

interface SpacesState {
  enabled: boolean;
  remotes: Record<string, string>; // spaceId -> clone URL
}

export class SpaceManager {
  private stateFile: string;
  private provisionRemote: (repoName: string) => Promise<string>;

  constructor(opts: SpaceManagerOpts = {}) {
    this.stateFile = opts.stateFile ?? path.join(os.homedir(), '.claude', 'toolkit-state', 'sync-spaces.json');
    this.provisionRemote = opts.provisionRemote ?? provisionGithubRemote;
  }

  private read(): SpacesState {
    try { return { enabled: false, remotes: {}, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; }
    catch { return { enabled: false, remotes: {} }; }
  }

  private write(s: SpacesState): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2));
  }

  isEnabled(): boolean { return this.read().enabled; }
  setEnabled(v: boolean): void { this.write({ ...this.read(), enabled: v }); }
  remoteFor(spaceId: string): string | null { return this.read().remotes[spaceId] ?? null; }
  recordRemote(spaceId: string, url: string): void {
    const s = this.read();
    s.remotes[spaceId] = url;
    this.write(s);
  }

  /** Idempotent: returns the recorded remote or provisions + records one. */
  async ensureRemote(space: SyncSpace): Promise<string> {
    const existing = this.remoteFor(space.id);
    if (existing) return existing;
    const url = await this.provisionRemote(repoNameForSpace(space));
    this.recordRemote(space.id, url);
    return url;
  }
}
