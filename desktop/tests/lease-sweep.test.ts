// Unit tests for the two lease-file sweeps (2026-07-30 lease-churn fix).
//
// Context: lease files are a 30s-per-open-session heartbeat. They used to be
// written into the PERSONAL SYNC SPACE, so every renew was picked up by the
// watcher and committed to the space's git repo — 93% of all file-changes in
// the real Personal repo, 30k commits, 673 MB. Two sweeps clean up after that:
//
//   sweepExpiredLeases()  — ongoing hygiene in the NEW (userData) location.
//                           Nothing deleted these before, so 59 of 60 lease
//                           files on the reporting machine were long expired.
//   sweepLegacyLeaseDir() — one-time removal of the OLD in-space directory, so
//                           the tracked files leave the repo in a single final
//                           delete-commit instead of churning forever.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepExpiredLeases, sweepLegacyLeaseDir } from '../src/main/conversations/lease-client';

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-sweep-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

function writeLease(dir: string, id: string, expiresAt: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ deviceId: 'dev-A', device: 'laptop-A', expiresAt }));
  return p;
}

describe('sweepExpiredLeases', () => {
  it('deletes expired leases and keeps live ones', () => {
    const dir = path.join(tmp, 'Leases');
    const dead = writeLease(dir, 'old', Date.now() - 60_000);
    const live = writeLease(dir, 'new', Date.now() + 300_000);

    expect(sweepExpiredLeases(dir)).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('deletes an unparseable lease file (it can never expire otherwise)', () => {
    // A malformed file is treated as "no lease" by readLeaseFile, so leaving it
    // on disk would leak a file that nothing ever cleans up.
    const dir = path.join(tmp, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, 'broken.json');
    fs.writeFileSync(bad, '{ not json');

    expect(sweepExpiredLeases(dir)).toBe(1);
    expect(fs.existsSync(bad)).toBe(false);
  });

  it('is a no-op on a missing directory and never throws', () => {
    expect(sweepExpiredLeases(path.join(tmp, 'nope'))).toBe(0);
  });

  it('leaves non-lease files alone', () => {
    const dir = path.join(tmp, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, 'README.md');
    fs.writeFileSync(readme, 'not a lease');

    expect(sweepExpiredLeases(dir)).toBe(0);
    expect(fs.existsSync(readme)).toBe(true);
  });
});

describe('sweepLegacyLeaseDir', () => {
  it('removes lease files from the old in-space dir and drops the dir', () => {
    const personal = path.join(tmp, 'Personal');
    const legacy = path.join(personal, 'Leases');
    // Mix of expired and still-live: the legacy location must be emptied
    // REGARDLESS of expiry — the point is to stop syncing them at all, and a
    // live lease is re-written to the new userData location within 30s.
    writeLease(legacy, 'expired', Date.now() - 60_000);
    writeLease(legacy, 'live', Date.now() + 300_000);

    expect(sweepLegacyLeaseDir(personal)).toBe(2);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('never removes a non-lease file, and keeps the dir when one survives', () => {
    // Defensive, matching sweepProjectSymlinks' discipline: this deletes inside
    // the user's own synced folder, so it only ever removes files it can positively
    // identify as leases. Anything else keeps the directory alive.
    const personal = path.join(tmp, 'Personal');
    const legacy = path.join(personal, 'Leases');
    writeLease(legacy, 'expired', Date.now() - 60_000);
    const mine = path.join(legacy, 'notes.txt');
    fs.writeFileSync(mine, 'user data');

    expect(sweepLegacyLeaseDir(personal)).toBe(1);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('does not recurse into subdirectories', () => {
    // Never recursive — the same rule sweepProjectSymlinks follows, because a
    // recursive delete through a junction irreversibly destroys the target.
    const personal = path.join(tmp, 'Personal');
    const legacy = path.join(personal, 'Leases');
    const nestedDir = path.join(legacy, 'nested');
    const nested = writeLease(nestedDir, 'deep', Date.now() - 60_000);

    expect(sweepLegacyLeaseDir(personal)).toBe(0);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('is a no-op when the legacy dir was never created', () => {
    expect(sweepLegacyLeaseDir(path.join(tmp, 'Personal'))).toBe(0);
  });
});
