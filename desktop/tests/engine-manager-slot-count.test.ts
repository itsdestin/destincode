// Task 13 fix pass — the review found that DiscoveredModel.totalSlots (the
// field capability-profile.ts's local concurrency cap reads) was written by
// NO production code: native-session-host.ts's resolveContextAndProfile never
// threaded a live engine reading through it, so every local session silently
// fell back to the conservative floor of 1 concurrent specialist — a
// regression from the pre-Task-13 flat cap of 4.
//
// This file proves the piece that closes that gap: EngineManager actually
// reads llama-server's n_slots off the SAME /props response that already
// supplies the context window (no second HTTP round trip), with the same
// defensive "absent/zero/non-numeric = unknown" posture n_ctx already gets
// (see engine-context-router-fallback.test.ts for the identical n_ctx bug —
// this mirrors that fix rather than reinventing the parsing strategy).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager, resolveSlotCount } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness engine-supervisor.test.ts uses — EngineManager's
// effectiveContextWindow() calls supervisor.ensureRunning(), which spawns a
// real subprocess unless child_process.spawn is replaced.
const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
  ee.pid = 4242;
  return ee;
}

let root: string;
let userData: string;
let home: NativeHome;
let mgr: EngineManager | undefined;

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(makeFakeChild());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-mgr-slots-'));
  userData = path.join(root, 'userData');
  home = new NativeHome(root);
});
afterEach(async () => {
  await mgr?.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Plant a fake usable install so effectiveContextWindow doesn't bail out on
 *  "not installed" before ever reaching /props — mirrors engine-manager.test.ts's
 *  own plantInstall() helper. */
function plantInstall(backend = 'cpu') {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
}

/** fetch stub: /health answers ok immediately (our fake child never really
 *  binds a port, so ensureRunning's identity guard needs pidOnPort wired to
 *  match); /props answers the given body; anything else answers {}. */
function fetchWithProps(propsBody: unknown, propsSpy?: () => void): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    // `includes`, not `endsWith`: effectiveContextWindow now asks
    // `/props?model=<id>` (design §C3 — the bare /props is the router's own
    // dummy and answers n_ctx 0 even with a model loaded). With endsWith, three
    // of the tests below went on passing while never reaching /props at all —
    // their expected numbers are also what the configured fallback returns.
    if (String(url).includes('/props')) {
      propsSpy?.();
      return { ok: true, status: 200, json: async () => propsBody } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
}

function plantedManager(fetchImpl: ReturnType<typeof vi.fn>, cacheDir: string) {
  return new EngineManager(home, userData, 9999, {
    fetchImpl: fetchImpl as any,
    // pidOnPort matches the fake child's pid so ensureRunning's "is this
    // really our child on the port" identity guard passes; short deadline/poll
    // so a broken test fails fast instead of waiting out the real 30s default.
    supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
  });
}

describe('resolveSlotCount — /props n_slots parsing (Task 13 fix pass)', () => {
  it('reads a positive integer straight through', () => {
    expect(resolveSlotCount(4)).toBe(4);
    expect(resolveSlotCount(1)).toBe(1);
  });

  it('treats an absent field as unknown, not zero slots', () => {
    expect(resolveSlotCount(undefined)).toBeNull();
  });

  it('treats a literal 0 as unknown (router mode with nothing resident)', () => {
    expect(resolveSlotCount(0)).toBeNull();
  });

  it('treats a non-numeric or negative reading as unknown, never a guessed count', () => {
    expect(resolveSlotCount('4')).toBeNull();
    expect(resolveSlotCount(NaN)).toBeNull();
    expect(resolveSlotCount(null)).toBeNull();
    expect(resolveSlotCount(-1)).toBeNull();
  });
});

// WHAT THIS FILE DOES *NOT* GUARD (measured 2026-09-05, so the next reader does
// not assume otherwise): the `contextLength` assertions below cannot tell a live
// /props reading from the configured fallback — every case here was written with
// the two numbers deliberately equal, so replacing `resolveEffectiveContext(
// loadedRaw, …)` with `(null, …)` leaves this whole file green. It guards
// totalSlots. That the live reading is really read, that it comes from
// `/props?model=<id>`, and that the fallback is the model's own length, are
// guarded in engine-set-config.test.ts.
describe('EngineManager.effectiveContextWindow — totalSlots (Task 13 fix pass)', () => {
  it('surfaces n_slots from the SAME /props body that already supplies context — one fetch serves both', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const propsSpy = vi.fn();
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 32_768 }, n_slots: 2 }, propsSpy);
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result).toEqual({ contextLength: 32_768, totalSlots: 2 });
    // ONE /props read produced BOTH fields — the exact "no second HTTP round
    // trip" property the fix pass exists to guarantee.
    expect(propsSpy).toHaveBeenCalledTimes(1);
  });

  it('an absent n_slots resolves to unknown (null), not a guessed count, while context still resolves normally', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 64_000 } }); // no n_slots field at all
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 64_000 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(64_000);
    expect(result.totalSlots).toBeNull();
  });

  it('router mode\'s literal n_slots: 0 (nothing resident) resolves to unknown, mirroring n_ctx\'s own 0-means-unknown handling', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    // {"model_path":"none","n_ctx":0,"n_slots":0} — the exact router-mode shape
    // the n_ctx regression test (engine-context-router-fallback.test.ts) documents.
    const fetchImpl = fetchWithProps({ model_path: 'none', n_ctx: 0, n_slots: 0 });
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(128_000);   // falls back to the configured -c, same as n_ctx's existing fix
    expect(result.totalSlots).toBeNull();          // NOT 0 slots — unknown
  });

  it('no engine installed yet: both fields are the conservative "unknown" default', async () => {
    mgr = new EngineManager(home, userData, 9999);
    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(32_768);
    expect(result.totalSlots).toBeNull();
  });
});
