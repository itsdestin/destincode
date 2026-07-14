import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDeviceIdentity } from '../src/main/device-identity';

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
