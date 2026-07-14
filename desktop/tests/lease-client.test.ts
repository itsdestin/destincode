// Unit tests for the lease-client (Plan 2b, Task 6). No network, no real hub —
// hubRequest is injected as a vi.fn() whose responses each test scripts. Renew
// timers are driven by vitest fake timers; the lease-file fallback is asserted
// against a REAL temp dir (readFileSync/existsSync), not mocks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLeaseClient, type LeaseClient } from '../src/main/conversations/lease-client';
import type { LeaseResult } from '../src/main/sync-hub-socket';

const DEVICE_ID = 'dev-A';
const DEVICE_NAME = 'laptop-A';
const RENEW_MS = 30_000;

function okResult(op: string, sessionId: string, expiresAt: number): LeaseResult {
  return { ok: true, op, sessionId, holder: { deviceId: DEVICE_ID, device: DEVICE_NAME, expiresAt } };
}
function lostResult(op: string, sessionId: string): LeaseResult {
  // Force-acquired by another device: ok=false, holder is now someone else.
  return { ok: false, op, sessionId, holder: { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 300_000 } };
}

function leaseFilePath(root: string, sessionId: string): string {
  return path.join(root, 'Leases', `${sessionId}.json`);
}

describe('lease-client', () => {
  let tmpRoot: string;
  let hubRequest: ReturnType<typeof vi.fn>;
  let takeoverSpy: ReturnType<typeof vi.fn>;
  let client: LeaseClient;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-test-'));
    hubRequest = vi.fn();
    takeoverSpy = vi.fn();
    client = createLeaseClient({
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      personalRoot: () => tmpRoot,
      hubRequest: hubRequest as any,
      onTakeoverRequest: takeoverSpy as any,
    });
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('acquire starts a renew timer and writes the lease file', async () => {
    const expiresAt = Date.now() + 300_000;
    hubRequest.mockResolvedValue(okResult('acquire', 's1', expiresAt));

    await client.acquire('s1');

    expect(client.isHeld('s1')).toBe(true);
    // Lease file written on acquire.
    const file = leaseFilePath(tmpRoot, 's1');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.deviceId).toBe(DEVICE_ID);
    expect(parsed.device).toBe(DEVICE_NAME);
    expect(parsed.expiresAt).toBe(expiresAt);

    // Renew timer fires at 30s.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('renew', 's1', Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('release stops the timer, deletes the file, and calls the hub', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('release', 's1', 0));
    await client.release('s1');

    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    expect(hubRequest).toHaveBeenCalledWith('release', 's1', DEVICE_ID);

    // No further renew after release.
    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('query prefers the hub result', async () => {
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 100 } });
    const r = await client.query('s1');
    expect(r).toEqual({ held: true, device: 'phone-B', expiresAt: expect.any(Number), source: 'hub' });
  });

  it('query falls back to an unexpired lease file when the hub returns null', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), JSON.stringify({ deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 100_000 }));

    const r = await client.query('s1');
    expect(r).toEqual({ held: true, device: 'phone-B', expiresAt: expect.any(Number), source: 'file' });
  });

  it('query treats an expired lease file as free', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), JSON.stringify({ deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() - 1000 }));

    const r = await client.query('s1');
    expect(r).toEqual({ held: false, source: 'none' });
  });

  it('query with hub null and no file reports free', async () => {
    hubRequest.mockResolvedValue(null);
    const r = await client.query('s1');
    expect(r).toEqual({ held: false, source: 'none' });
  });

  it('handleTakeoverRequest invokes the callback only for a HELD session', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    const from = { deviceId: 'dev-B', device: 'phone-B' };
    client.handleTakeoverRequest('s1', from);
    expect(takeoverSpy).toHaveBeenCalledWith('s1', from);

    // Unheld session — ignored.
    takeoverSpy.mockClear();
    client.handleTakeoverRequest('s-unheld', from);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('renew failure (force-acquired) stops the timer, deletes the file, and calls onTakeoverRequest', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    // Next renew fails — another device force-acquired.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(lostResult('renew', 's1'));
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    // Called with sessionId only (no `from` on the force-acquire path).
    expect(takeoverSpy).toHaveBeenCalledWith('s1');

    // Timer is stopped — no further renew.
    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('transient-null renew keeps the lease and keeps renewing', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    // Next renew: hub transiently disconnected (null). Lease must NOT drop.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
    // File fallback still present and fresh (local-clock deadline in the future).
    const file = leaseFilePath(tmpRoot, 's1');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).expiresAt).toBeGreaterThan(Date.now());

    // A SECOND renew is attempted on the next tick — the timer kept running.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('renew', 's1', Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
  });

  it('query treats a malformed lease file as free', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), '{ not json');

    const r = await client.query('s1');
    expect(r).toEqual({ held: false, source: 'none' });
  });

  it('destroy clears all renew timers', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');
    hubRequest.mockResolvedValue(okResult('acquire', 's2', Date.now() + 300_000));
    await client.acquire('s2');

    client.destroy();
    expect(client.isHeld('s1')).toBe(false);
    expect(client.isHeld('s2')).toBe(false);

    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's2', DEVICE_ID);
  });

  it('acquire on a hub reject (someone else holds it) does not start a timer or write a file', async () => {
    hubRequest.mockResolvedValue(lostResult('acquire', 's1'));
    const res = await client.acquire('s1');

    expect(res && res.ok).toBe(false);
    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);

    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('acquire on hub-disconnected (null) optimistically holds locally', async () => {
    hubRequest.mockResolvedValue(null);
    const res = await client.acquire('s1');

    expect(res && res.ok).toBe(true);
    expect(client.isHeld('s1')).toBe(true);
    // File written with a locally-synthesized expiry.
    const file = leaseFilePath(tmpRoot, 's1');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.deviceId).toBe(DEVICE_ID);
    expect(typeof parsed.expiresAt).toBe('number');
  });
});
