import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDeviceIdentity, getMachineIdentity } from '../src/main/device-identity';

// A loose UUID shape check — we only need to confirm randomUUID produced a real id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-device-id-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('getDeviceIdentity', () => {
  it('creates device-id.json with a UUID id on first call', () => {
    const { id } = getDeviceIdentity(tmp);
    expect(id).toMatch(UUID_RE);
    // The id must have been persisted to disk under the userData dir.
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'device-id.json'), 'utf8'));
    expect(onDisk.id).toBe(id);
  });

  it('returns the SAME id on a second call (persistence, no regeneration)', () => {
    const first = getDeviceIdentity(tmp).id;
    // Prove the second call reads the existing file rather than rewriting it:
    // if the id changed, persistence is broken.
    const second = getDeviceIdentity(tmp).id;
    expect(second).toBe(first);
  });

  it('replaces a corrupt file with a fresh valid id and never throws', () => {
    const p = path.join(tmp, 'device-id.json');
    fs.writeFileSync(p, '{not valid json at all');
    const { id } = getDeviceIdentity(tmp);
    expect(id).toMatch(UUID_RE);
    // The corrupt bytes were overwritten with the fresh, valid record.
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk.id).toBe(id);
  });

  it('treats valid JSON with a missing/empty id as corrupt (regenerates)', () => {
    const p = path.join(tmp, 'device-id.json');
    fs.writeFileSync(p, JSON.stringify({ id: '' }));
    const { id } = getDeviceIdentity(tmp);
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe('');
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk.id).toBe(id);
  });
});

describe('getMachineIdentity', () => {
  // Stands in for the BUILT app's userData dir. main.ts passes the REAL one,
  // captured from app.getPath('userData') BEFORE any dev-profile override — so
  // nothing here or there hardcodes the app's folder name (see Task 2 Step 3).
  const builtApp = () => path.join(tmp, 'youcoded');

  it('returns the built app userData id when it exists', () => {
    const builtId = getDeviceIdentity(builtApp()).id; // built app minted its id
    expect(getMachineIdentity(builtApp())).toEqual({ id: builtId });
  });

  it('returns null when the built app has never run (no file to adopt)', () => {
    expect(getMachineIdentity(builtApp())).toBeNull();
  });

  it('returns null on a corrupt built-app id file — never throws, never mints', () => {
    fs.mkdirSync(builtApp(), { recursive: true });
    fs.writeFileSync(path.join(builtApp(), 'device-id.json'), '{not valid json');
    expect(getMachineIdentity(builtApp())).toBeNull();
  });

  it('returns null for a valid-JSON file with an empty id', () => {
    fs.mkdirSync(builtApp(), { recursive: true });
    fs.writeFileSync(path.join(builtApp(), 'device-id.json'), JSON.stringify({ id: '' }));
    expect(getMachineIdentity(builtApp())).toBeNull();
  });

  it('NEVER writes — a dev profile must not mint the built app identity', () => {
    expect(getMachineIdentity(builtApp())).toBeNull();
    // The absence of the dir is the assertion: a read-only resolver leaves no trace.
    expect(fs.existsSync(builtApp())).toBe(false);
  });

  // THE REGRESSION PIN. This is the bug: three userData profiles on one machine
  // produced three "GalaxyBook" rows because the registry keyed on the per-install
  // id. Leases still need those ids distinct; the registry must not.
  it('collapses built app + dev profiles to ONE machine id while leases stay distinct', () => {
    const builtInstall = getDeviceIdentity(builtApp()).id;
    const devInstall = getDeviceIdentity(path.join(tmp, 'youcoded-dev')).id;
    const dev2Install = getDeviceIdentity(path.join(tmp, 'youcoded-dev2')).id;

    // Lease identity stays per-INSTALL — this invariant is load-bearing and must NOT regress.
    expect(new Set([builtInstall, devInstall, dev2Install]).size).toBe(3);

    // Registry identity is per-MACHINE: all three profiles ask the SAME built-app
    // dir, so all three resolve to one row.
    expect(getMachineIdentity(builtApp())).toEqual({ id: builtInstall });
  });
});
