// `engine:set-config` — the one write for every engine-wide setting, and the
// wait that keeps it from killing a reply (design §B / §C2 / §C3).
//
// THE FAILURE THESE GUARD AGAINST: `EngineSupervisor.stop()` has no in-flight
// guard of its own — the only `inFlight > 0` check in the whole class is inside
// the idle timer — so restarting the engine the instant a switch is flipped
// SIGTERMs llama-server mid-answer and the streaming reply the user is reading
// dies halfway through a sentence. The signed contract (R19) promises the
// opposite: "a model in use reloads on its next message".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness as engine-manager-slot-count.test.ts: ensureRunning()
// spawns a real subprocess unless child_process.spawn is replaced.
const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const children: any[] = [];
function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
  ee.pid = 4242;
  children.push(ee);
  return ee;
}

const PORT = 9999;
let root: string;
let userData: string;
let cacheDir: string;
let home: NativeHome;
let mgr: EngineManager | undefined;

beforeEach(() => {
  mockSpawn.mockReset();
  children.length = 0;
  mockSpawn.mockImplementation(() => makeFakeChild());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-set-config-'));
  userData = path.join(root, 'userData');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  home = new NativeHome(root);
});
afterEach(async () => {
  await mgr?.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
});

function plantInstall(backend = 'cpu') {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
}

/** Every URL the manager or the supervisor fetched, in order. */
let urls: string[];

/** /health answers ok; everything else answers an empty JSON body. A caller can
 *  hand back its own Response for one URL prefix (the streaming reply below). */
function makeFetch(special?: (url: string) => Response | undefined) {
  urls = [];
  return vi.fn(async (input: any, _init?: any) => {
    const url = String(input);
    urls.push(url);
    const own = special?.(url);
    if (own) return own as any;
    if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
  });
}

function makeManager(fetchImpl: any, extra: Record<string, unknown> = {}) {
  return new EngineManager(home, userData, PORT, {
    fetchImpl,
    // A chip probe that answers instantly: status() warms it, and the real one
    // shells out to nvidia-smi / ldconfig.
    probeChip: async () => ({ vendor: null, gfxTarget: null }),
    supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
    // A suite cannot spend the real ten minutes proving the bound exists.
    configApplyPollMs: 2,
    configApplyMaxWaitMs: 5_000,
    ...extra,
  });
}

// Spelled out rather than imported from model-presets: this test is asserting
// WHERE the engine's preset file lands, and reusing the function under test to
// say where to look would make that assertion vacuous.
const presetPath = () => path.join(root, '.youcoded', 'engine', 'models.ini');
const engineSection = () => ((home.readJson('config.json') as any)?.engine ?? {});
const settled = () => new Promise((r) => setTimeout(r, 40));

// ---------------------------------------------------------------------------
// A reply that is streaming right now, held open by the test.
// ---------------------------------------------------------------------------
/** Boot the engine and start a tracked streaming request that stays open until
 *  `finish()` is called. Returns the text the caller actually received, so the
 *  test can prove the reply survived rather than merely that nothing crashed. */
async function startStreamingReply(m: EngineManager, fetchImpl: any) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  // The chat request answers with that stream; everything else keeps the
  // default behaviour above.
  (fetchImpl as any).streamFor = (url: string) => (url.includes('/chat/completions')
    ? new Response(source, { status: 200 })
    : undefined);

  const hook = m.registryHook();
  await hook.ensureRunning();
  const tracked = hook.fetchImpl();
  const res = await tracked(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: 'POST' } as any);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let text = '';
  const decoder = new TextDecoder();
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      text += decoder.decode(value);
    }
  })();
  controller.enqueue(encoder.encode('the first half '));
  await vi.waitFor(() => { expect(text).toBe('the first half '); });
  return {
    received: () => text,
    finish: async () => {
      controller.enqueue(encoder.encode('and the second.'));
      controller.close();
      await drain;
    },
  };
}

describe('engine:set-config — a speed switch waits for the reply to finish (§B, R3-5)', () => {
  it('does not kill a streaming reply, and restarts the moment it ends', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    let stream: ((url: string) => Response | undefined) | undefined;
    const fetchImpl: any = makeFetch((url) => stream?.(url));
    stream = (url) => (fetchImpl.streamFor ? fetchImpl.streamFor(url) : undefined);
    mgr = makeManager(fetchImpl);

    const reply = await startStreamingReply(mgr, fetchImpl);
    expect(children).toHaveLength(1);
    const firstChild = children[0];

    await mgr.setConfig({ speed: { speculative: false } });

    // The VALUE is saved immediately — waiting to apply it is not waiting to
    // save it, or a crash in between would lose the user's answer.
    expect(engineSection().speed).toEqual({ speculative: false, compressCache: true });
    expect(mgr.status().configApplyPending).toBe(true);
    expect(mgr.status().speed).toEqual({ speculative: false, compressCache: true });

    // Long enough for ~20 poll intervals to have passed.
    await settled();
    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(mgr.status().configApplyPending).toBe(true);

    // The reply arrives whole — this is the thing the restart would have cut.
    await reply.finish();
    expect(reply.received()).toBe('the first half and the second.');

    await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
    expect(firstChild.kill).toHaveBeenCalled();
    // It was RUNNING, so it comes back — the user's next message must not pay
    // for a boot they did not ask for.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mgr.status().state).toBe('running');
    expect(mgr.status().configApplyError).toBeNull();
  });

  it('applies anyway once the wait runs out — a stream that never ends cannot park a setting forever', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    let stream: ((url: string) => Response | undefined) | undefined;
    const fetchImpl: any = makeFetch((url) => stream?.(url));
    stream = (url) => (fetchImpl.streamFor ? fetchImpl.streamFor(url) : undefined);
    // 30 ms stands in for the shipped ten minutes (design §C2's bound).
    mgr = makeManager(fetchImpl, { configApplyMaxWaitMs: 30 });

    await startStreamingReply(mgr, fetchImpl);   // deliberately never finished
    const firstChild = children[0];

    await mgr.setConfig({ speed: { compressCache: false } });
    await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
    expect(firstChild.kill).toHaveBeenCalled();
  });

  it('an engine that was NOT running is left stopped — a setting does not boot one', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    mgr = makeManager(makeFetch());

    await mgr.setConfig({ speed: { speculative: false } });
    await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(engineSection().speed).toEqual({ speculative: false, compressCache: true });
  });
});

describe('engine:set-config — a context change reloads, it does not restart (§B, R2-24)', () => {
  it('rewrites the preset\'s [*] section and asks the router to re-read it, with no new process', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    const fetchImpl = makeFetch();
    mgr = makeManager(fetchImpl);

    const hook = mgr.registryHook();
    await hook.ensureRunning();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const firstChild = children[0];
    urls.length = 0;

    await mgr.setConfig({ contextSize: 8_192 });
    await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

    expect(engineSection().contextSize).toBe(8_192);
    // The whole file, not a substring: a `[*]` section that also carried a
    // leftover key, or a ctx-size written into the wrong section, would both
    // pass a "contains 8192" check while meaning something different.
    expect(fs.readFileSync(presetPath(), 'utf8')).toBe('[*]\nctx-size = 8192\nsleep-idle-seconds = 300\n');
    // Exactly the reload URL — `/models` without the query does NOT re-read the
    // preset, and that is the whole difference between the change landing and
    // the change being invisible until the next launch.
    expect(urls).toContain(`http://127.0.0.1:${PORT}/models?reload=1`);
    // NO restart: the process that was serving is the process still serving.
    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('writes a section for a model that has its own settings, and none for a model that does not', async () => {
    plantInstall();
    fs.writeFileSync(path.join(cacheDir, 'tuned-model.gguf'), 'x');
    fs.writeFileSync(path.join(cacheDir, 'untouched-model.gguf'), 'x');
    await home.mutateJson('config.json', () => ({
      v: 1,
      engine: {
        cacheDir,
        contextSize: 32_768,
        models: {
          'tuned-model': { contextLength: 16_384, keepLoaded: true, gpuLayers: 24, extraFlags: '' },
          // A model with settings but NOT on disk: a section for it would
          // resurrect a deleted model as a row that can never load (probed).
          'deleted-model': { contextLength: 4_096 },
        },
      },
    }));
    mgr = makeManager(makeFetch());

    await mgr.setConfig({ contextSize: 65_536 });
    await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

    expect(fs.readFileSync(presetPath(), 'utf8')).toBe(
      '[*]\nctx-size = 65536\nsleep-idle-seconds = 300\n\n'
      + '[tuned-model]\nctx-size = 16384\nn-gpu-layers = 24\nsleep-idle-seconds = -1\n',
    );
  });

  it('refuses a context length below the engine\'s floor, in the words the card shows', async () => {
    plantInstall();
    mgr = makeManager(makeFetch());
    await expect(mgr.setConfig({ contextSize: 512 })).rejects.toThrow('Context length must be at least 1024 tokens.');
    expect(engineSection().contextSize).toBeUndefined();   // nothing was written
  });
});

describe('engine:set-context — the alias every existing caller still goes through', () => {
  it('does exactly what set-config({contextSize}) does', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    const fetchImpl = makeFetch();
    mgr = makeManager(fetchImpl);

    const hook = mgr.registryHook();
    await hook.ensureRunning();
    urls.length = 0;

    // The engine card, the remote browser shim and the WS handler all call this
    // one method with a bare number.
    await mgr.setContext(65_536);
    await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

    expect(engineSection().contextSize).toBe(65_536);
    expect(mgr.status().contextSize).toBe(65_536);
    expect(fs.readFileSync(presetPath(), 'utf8')).toBe('[*]\nctx-size = 65536\nsleep-idle-seconds = 300\n');
    expect(urls).toContain(`http://127.0.0.1:${PORT}/models?reload=1`);
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it('keeps the same refusal it always had', async () => {
    plantInstall();
    mgr = makeManager(makeFetch());
    await expect(mgr.setContext(1_023)).rejects.toThrow('Context length must be at least 1024 tokens.');
  });
});

// ---------------------------------------------------------------------------
// §C3 — which /props answers the question
// ---------------------------------------------------------------------------
describe('effectiveContextWindow asks the MODEL, not the router (§C3)', () => {
  /** /props answers `body` only when asked about a named model; the bare /props
   *  answers what the router really answers — a dummy with n_ctx 0. */
  function fetchProps(body: unknown) {
    urls = [];
    return vi.fn(async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
      if (url.includes('/props')) {
        const named = url.includes('?model=');
        return { ok: true, status: 200, json: async () => (named ? body : { model_path: 'none', n_ctx: 0 }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
  }

  it('names the model in the query, url-encoded', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
    mgr = makeManager(fetchProps({ default_generation_settings: { n_ctx: 16_384 }, n_slots: 4 }));

    const result = await mgr.effectiveContextWindow('gemma 4/E2B-it-Q8_0');
    // The exact URL: a bare /props answers `n_ctx: 0` even with a model loaded
    // (probed 2026-09-05), so the query string is the whole point — and a model
    // id is a filename, which can hold characters a URL cannot.
    expect(urls).toContain(`http://127.0.0.1:${PORT}/props?model=gemma%204%2FE2B-it-Q8_0`);
    expect(result.contextLength).toBe(16_384);
    expect(result.totalSlots).toBe(4);
  });

  it('an unloaded model falls back to ITS OWN configured length, not the engine-wide one', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({
      v: 1,
      engine: { cacheDir, contextSize: 32_768, models: { 'big-context-model': { contextLength: 131_072 } } },
    }));
    // No child for an unloaded model, so even the named /props answers the
    // router's dummy zero.
    mgr = makeManager(fetchProps({ model_path: 'none', n_ctx: 0 }));

    // 131072, NOT 32768: sizing a model the user set to 128k as if it were on
    // the engine's default is the under-count that empties the window.
    expect((await mgr.effectiveContextWindow('big-context-model')).contextLength).toBe(131_072);
  });

  it('a model with no setting of its own still falls back to the engine-wide length', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({
      v: 1,
      engine: { cacheDir, contextSize: 64_000, models: { 'some-other-model': { contextLength: 131_072 } } },
    }));
    mgr = makeManager(fetchProps({ model_path: 'none', n_ctx: 0 }));

    expect((await mgr.effectiveContextWindow('plain-model')).contextLength).toBe(64_000);
  });

  it('a live reading from the model still wins over what was configured', async () => {
    plantInstall();
    await home.mutateJson('config.json', () => ({
      v: 1,
      engine: { cacheDir, contextSize: 32_768, models: { 'clamped-model': { contextLength: 131_072 } } },
    }));
    // The server clamped the request down to what the VRAM allowed: believe it.
    mgr = makeManager(fetchProps({ default_generation_settings: { n_ctx: 8_192 } }));

    expect((await mgr.effectiveContextWindow('clamped-model')).contextLength).toBe(8_192);
  });
});
