// Task 13 fix pass — the review found that DiscoveredModel.totalSlots (the
// field capability-profile.ts's local concurrency cap reads) was written by
// NO production code: native-session-host.ts's resolveContextAndProfile never
// threaded a live engine reading through it, so every local session silently
// fell back to the conservative floor of 1 concurrent specialist — a
// regression from the pre-Task-13 flat cap of 4.
//
// This file proves the piece that closes that gap: EngineManager actually
// reads llama-server's slot count off the SAME /props response that already
// supplies the context window (no second HTTP round trip), with the same
// defensive "absent/zero/non-numeric = unknown" posture n_ctx already gets
// (see engine-context-router-fallback.test.ts for the identical n_ctx bug —
// this mirrors that fix rather than reinventing the parsing strategy).
//
// 2026-09-04 correction (measured live against the pinned b10665 in router
// mode): the field is `total_slots`, NOT `n_slots`, and it only appears when
// the request names a model — `GET /props` with no `?model=` answers
// `{model_path:"none", default_generation_settings.n_ctx: 0}` and NO slot
// field at all, while `GET /props?model=<id>` answers `total_slots: 4` plus
// the PER-SLOT n_ctx (`-c` / slots). The earlier version of this file pinned
// the wrong name and the model-less URL, which is exactly why the bug shipped
// with every test green: totalSlots was ALWAYS null in production, so every
// local model was capped at ONE helper while the engine had four slots.
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
 *  match); /props (with or without a `?model=` query — the spy receives the
 *  full URL so a test can assert on the query) answers the given body;
 *  anything else answers {}. */
function fetchWithProps(propsBody: unknown, propsSpy?: (url: string) => void): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    if (new URL(String(url)).pathname === '/props') {
      propsSpy?.(String(url));
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

describe('resolveSlotCount — /props total_slots parsing (Task 13 fix pass)', () => {
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

describe('EngineManager.effectiveContextWindow — totalSlots (Task 13 fix pass)', () => {
  it('asks /props?model=<id> and surfaces total_slots plus the PER-SLOT n_ctx from that one body — one fetch serves both', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const propsSpy = vi.fn();
    // The exact b10665 router-mode answer to /props?model=Qwen3.5-2B-Q8_0 with
    // `-c 16384 --parallel 4`: n_ctx is 16384 / 4, the window ONE request gets.
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 4096 }, total_slots: 4 }, propsSpy);
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('Qwen3.5-2B-Q8_0');
    // The honest window is the per-slot one the engine reported, NOT the -c we
    // passed on the command line (that is the TOTAL shared across all slots).
    expect(result).toEqual({ contextLength: 4096, totalSlots: 4 });
    // ONE /props read produced BOTH fields — the exact "no second HTTP round
    // trip" property the fix pass exists to guarantee — and it named the model,
    // because a model-less /props carries no slot field on this build at all.
    expect(propsSpy).toHaveBeenCalledTimes(1);
    expect(propsSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/props?model=Qwen3.5-2B-Q8_0');
  });

  it('URL-encodes the model id in the query (router ids can carry characters a query string cannot)', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const propsSpy = vi.fn();
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 4096 }, total_slots: 4 }, propsSpy);
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    await mgr.effectiveContextWindow('odd model&id');
    expect(propsSpy).toHaveBeenCalledWith(`http://127.0.0.1:9999/props?model=${encodeURIComponent('odd model&id')}`);
  });

  it('an OLDER build that still answers n_slots (no total_slots) is read through the fallback name', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 32_768 }, n_slots: 2 });
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result).toEqual({ contextLength: 32_768, totalSlots: 2 });
  });

  it('total_slots wins over a stray n_slots when a body somehow carries both', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 4096 }, total_slots: 4, n_slots: 1 });
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.totalSlots).toBe(4);
  });

  it('a body with no slot field at all resolves to unknown (null), not a guessed count, while context still resolves normally', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 64_000 } }); // neither total_slots nor n_slots
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 64_000 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(64_000);
    expect(result.totalSlots).toBeNull();
  });

  it('the MODEL-LESS router answer (model_path "none", n_ctx 0, no slot field) still resolves to the configured -c and unknown slots', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    // Measured 2026-09-04 on b10665: this is what /props returns when the
    // request names no model, or names one that is not resident yet. The app
    // now always sends ?model=, but a not-yet-loaded model can still get this
    // shape, and it must degrade exactly as before — never to "0 slots".
    const fetchImpl = fetchWithProps({ model_path: 'none', default_generation_settings: { n_ctx: 0 } });
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(128_000);   // falls back to the configured -c, same as n_ctx's existing fix
    expect(result.totalSlots).toBeNull();          // NOT 0 slots — unknown
  });

  it('a literal total_slots: 0 resolves to unknown, mirroring n_ctx\'s own 0-means-unknown handling', async () => {
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const fetchImpl = fetchWithProps({ model_path: 'none', n_ctx: 0, total_slots: 0 });
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
    plantInstall();
    mgr = plantedManager(fetchImpl, cacheDir);

    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(128_000);
    expect(result.totalSlots).toBeNull();
  });

  it('no engine installed yet: both fields are the conservative "unknown" default', async () => {
    mgr = new EngineManager(home, userData, 9999);
    const result = await mgr.effectiveContextWindow('some-model');
    expect(result.contextLength).toBe(32_768);
    expect(result.totalSlots).toBeNull();
  });
});
