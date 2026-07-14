// desktop/tests/sync-spaces-device-registry.test.ts
// Covers the Personal/Devices friendly-name registry (Plan 2b Task 4, spec §10a):
// round-trip, heartbeat that must not clobber a synced rename, fold-on-read of a
// cross-device conflict copy, and fail-soft skipping of malformed files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readDevices, upsertSelf, renameDevice,
  mergeDeviceEntries, DEVICE_REGISTRY_SCHEMA, type DeviceRecord,
} from '../src/main/sync-spaces/device-registry';

let personal: string;
beforeEach(() => { personal = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dreg-')); });
afterEach(() => { fs.rmSync(personal, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const dir = () => path.join(personal, 'Devices');
const write = (file: string, obj: unknown) => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), file), JSON.stringify(obj));
};
// Device ids are UUIDs; the fixture id below stands in for one (it just has to
// be a stable string that can never contain the " (from " conflict-copy marker).
const E = (over: Partial<DeviceRecord>): DeviceRecord => ({
  schemaVersion: DEVICE_REGISTRY_SCHEMA, id: 'dev-1', name: 'Laptop',
  platform: 'win32', lastSeen: 1, updatedAt: 1, ...over,
});

describe('device registry store — I/O', () => {
  it('round-trips a device record through upsertSelf + readDevices', async () => {
    await upsertSelf(personal, { id: 'dev-1', name: 'My Laptop', platform: 'win32' });
    expect(fs.existsSync(path.join(dir(), 'dev-1.json'))).toBe(true);
    const got = readDevices(personal);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'dev-1', name: 'My Laptop', platform: 'win32' });
    expect(got[0].lastSeen).toBeGreaterThan(0);
    expect(got[0].updatedAt).toBeGreaterThan(0);
  });

  it('upsertSelf defaults the friendly name to os.hostname() when none is given', async () => {
    await upsertSelf(personal, { id: 'dev-2', platform: 'darwin' });
    expect(readDevices(personal)[0].name).toBe(os.hostname());
  });

  it('returns [] when the Devices dir does not exist', () => {
    expect(readDevices(personal)).toEqual([]);
  });

  it('upsertSelf heartbeat bumps lastSeen but does NOT clobber a newer synced name', async () => {
    // Another device renamed us and that edit synced here with a high updatedAt.
    write('dev-1.json', E({ name: 'Renamed On Phone', lastSeen: 10, updatedAt: 9_999_999_999_999 }));
    await upsertSelf(personal, { id: 'dev-1', platform: 'win32' }); // bare heartbeat, no name
    const got = readDevices(personal)[0];
    expect(got.name).toBe('Renamed On Phone');      // name preserved
    expect(got.lastSeen).toBeGreaterThan(10);       // liveness advanced
    expect(got.updatedAt).toBe(9_999_999_999_999);  // updatedAt NOT churned
  });

  it('upsertSelf with a differing name bumps updatedAt and changes the name', async () => {
    write('dev-1.json', E({ name: 'Old', updatedAt: 5 }));
    await upsertSelf(personal, { id: 'dev-1', name: 'New', platform: 'win32' });
    const got = readDevices(personal)[0];
    expect(got.name).toBe('New');
    expect(got.updatedAt).toBeGreaterThan(5);
  });

  it('renameDevice sets name + bumps updatedAt, preserving lastSeen/platform', async () => {
    write('dev-1.json', E({ name: 'Old', platform: 'linux', lastSeen: 42, updatedAt: 5 }));
    await renameDevice(personal, 'dev-1', 'Fresh');
    const got = readDevices(personal)[0];
    expect(got.name).toBe('Fresh');
    expect(got.platform).toBe('linux'); // preserved
    expect(got.lastSeen).toBe(42);      // preserved
    expect(got.updatedAt).toBeGreaterThan(5);
  });

  it('renameDevice to the identical name is a no-op (no mtime churn)', async () => {
    write('dev-1.json', E({ name: 'Same', updatedAt: 5 }));
    const file = path.join(dir(), 'dev-1.json');
    const m1 = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await renameDevice(personal, 'dev-1', 'Same');
    expect(fs.statSync(file).mtimeMs).toBe(m1); // skipped
  });

  it('folds a conflict copy on read — newer name wins AND lastSeen is the max', () => {
    // Canonical: older name, higher lastSeen. Conflict copy (a cross-device
    // rename the transport left as a copy): newer name, lower lastSeen.
    write('dev-1.json', E({ name: 'Old Name', lastSeen: 100, updatedAt: 10 }));
    write('dev-1 (from OtherDevice, 2026-07-14).json', E({ name: 'New Name', lastSeen: 50, updatedAt: 20 }));
    const got = readDevices(personal);
    expect(got).toHaveLength(1);        // folded into one record
    expect(got[0].name).toBe('New Name'); // updatedAt 20 wins (LWW)
    expect(got[0].lastSeen).toBe(100);    // max across both copies
  });

  it('skips corrupt / unknown-schema files without throwing', () => {
    write('dev-1.json', E({ name: 'Good' }));
    fs.writeFileSync(path.join(dir(), 'bad.json'), '{ not json');
    write('future.json', { schemaVersion: 999, id: 'future', name: 'x', platform: 'p', lastSeen: 1, updatedAt: 1 });
    expect(readDevices(personal).map((e) => e.id).sort()).toEqual(['dev-1']);
  });
});

describe('device registry store — pure merge', () => {
  it('mergeDeviceEntries is commutative (name LWW by updatedAt, lastSeen = max)', () => {
    const a = E({ name: 'A', lastSeen: 100, updatedAt: 3 });
    const b = E({ name: 'B', lastSeen: 50, updatedAt: 9 });
    const ab = mergeDeviceEntries(a, b);
    const ba = mergeDeviceEntries(b, a);
    expect(ab).toEqual(ba);          // convergent
    expect(ab.name).toBe('B');       // updatedAt 9 wins
    expect(ab.lastSeen).toBe(100);   // max
    expect(ab.updatedAt).toBe(9);    // max
  });
});
