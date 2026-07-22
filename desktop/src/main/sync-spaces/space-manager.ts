// desktop/src/main/sync-spaces/space-manager.ts
// Sync enable/disable state + per-space GitHub remote provisioning.
// State lives at ~/.claude/toolkit-state/sync-spaces.json.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { getGithubClient, GITHUB_AUTH_ERROR_CODE, type GithubClient } from '../github-client';
import type { SyncSpace } from './types';

/** The one client method provisioning needs — injectable for tests. */
type RepoCreator = Pick<GithubClient, 'createPrivateRepo'>;

export function repoNameForSpace(space: SyncSpace): string {
  if (space.kind === 'personal') return 'youcoded-sync-personal';
  const raw = space.id.replace(/^project:/, '');
  const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Why the hash suffix: the repo name IS the sync identity. The slug alone is
  // neither unique ('My App' and 'My-App' both slug to 'my-app' — two different
  // projects would silently cross-sync into one repo) nor total (an all-symbol
  // or non-Latin name slugs to ''). Hashing the LOWERCASED id keeps the name
  // stable across devices (same folder name → same repo) while distinct
  // folder names always get distinct repos. Do not "simplify" this away.
  const short = createHash('sha1').update(raw.toLowerCase()).digest('hex').slice(0, 8);
  return `youcoded-sync-project-${name || 'x'}-${short}`;
}

/** Creates a private repo and returns its clone URL. Phase 2 (2026-07-22
 *  sync-setup overhaul): goes through the shared github-client REST path —
 *  no `gh` CLI required — using the app's stored token, or gh's own token on
 *  machines that have one (the client's acquisition order handles both).
 *  An ALREADY-EXISTING repo is success, not failure — the state file
 *  recording provisioned URLs is per-device, so the user's second device
 *  re-runs this for repos the first device already created; that recovery
 *  lives inside createPrivateRepo (422 → adopt). Errors are already
 *  plain-language + typed (syncErrorCode) — syncSpace surfaces them verbatim
 *  as the space's error event every cycle. */
export async function provisionGithubRemote(repoName: string, client: RepoCreator | null = getGithubClient()): Promise<string> {
  if (!client) {
    // main.ts registers the client before startSyncSpaces; reaching this means
    // a wiring regression, but the user still needs an actionable message.
    const e: any = new Error('Not connected to GitHub — connect your GitHub account in the Sync settings');
    e.syncErrorCode = GITHUB_AUTH_ERROR_CODE;
    throw e;
  }
  return client.createPrivateRepo(repoName);
}

interface SpaceManagerOpts {
  stateFile?: string; // injectable for tests
  provisionRemote?: (repoName: string) => Promise<string>;
}

interface SpacesState {
  enabled: boolean;
  remotes: Record<string, string>; // spaceId -> clone URL
  // spaceId -> ms epoch of the last COMPLETED pull+push against a real remote.
  // This is the "has this device ever actually synced?" evidence the panel's
  // green state is gated on — recentEvents is per-boot, so without a persisted
  // marker a restart would forget that a first sync ever happened. Absent key
  // = never synced. Written by service.broadcast on every real 'synced' event.
  lastSync?: Record<string, number>;
}

export class SpaceManager {
  private stateFile: string;
  private provisionRemote: (repoName: string) => Promise<string>;

  constructor(opts: SpaceManagerOpts = {}) {
    this.stateFile = opts.stateFile ?? path.join(os.homedir(), '.claude', 'toolkit-state', 'sync-spaces.json');
    this.provisionRemote = opts.provisionRemote ?? provisionGithubRemote;
  }

  private read(): SpacesState {
    // A corrupt state file deliberately degrades to defaults and self-heals:
    // ensureRemote re-provisions, and the already-exists recovery in
    // provisionGithubRemote finds the repos the lost state pointed at.
    try { return { enabled: false, remotes: {}, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; }
    catch { return { enabled: false, remotes: {} }; }
  }

  private write(s: SpacesState): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    // Temp-file + rename: the dev instance and the built app share ~/.claude,
    // and rename is atomic — a concurrent reader never sees a half-written file.
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  isEnabled(): boolean { return this.read().enabled; }
  /** ms epoch of this space's last completed real sync on THIS device, or null
   *  if it has never synced. Survives restarts (unlike recentEvents). */
  lastSyncFor(spaceId: string): number | null { return this.read().lastSync?.[spaceId] ?? null; }
  recordSyncSuccess(spaceId: string, at: number): void {
    const s = this.read();
    s.lastSync = { ...s.lastSync, [spaceId]: at };
    this.write(s);
  }
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
