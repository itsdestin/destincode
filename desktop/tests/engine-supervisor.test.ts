import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  EngineSupervisor,
  parseSsListenerPid,
  parseLsofPid,
  parseNetstatListenerPid,
} from '../src/main/engine/engine-supervisor';

const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// fs is partially mocked: mkdirSync is a spy (the supervisor creates the models
// cache dir before spawning) so tests don't create stray dirs from 'C:/fake/cache'.
const mockMkdir = vi.fn();
vi.mock('fs', async (orig) => ({
  ...(await orig() as any),
  mkdirSync: (...args: any[]) => mockMkdir(...args),
}));

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
  ee.pid = 4242;
  return ee;
}

/** fetch that starts refusing, then answers /health ok after delayMs. */
function healthAfter(delayMs: number): ReturnType<typeof vi.fn> {
  const start = Date.now();
  return vi.fn(async (url: string) => {
    if (Date.now() - start < delayMs) throw new Error('ECONNREFUSED');
    if (String(url).endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
}

function makeSupervisor(fetchImpl: any, extra: Record<string, any> = {}) {
  return new EngineSupervisor({
    binaryPath: 'C:/fake/llama-server.exe',
    port: 9999,
    cacheDir: 'C:/fake/cache',
    contextSize: 32768,
    fetchImpl,
    readyDeadlineMs: 2_000,
    readyPollMs: 10,
    idleMs: 10 * 60_000,
    idleCheckMs: 60_000,
    ...extra,
  });
}

let sup: EngineSupervisor;
beforeEach(() => { mockSpawn.mockReset(); mockMkdir.mockReset(); });
afterEach(async () => { await sup?.stop(); });

describe('EngineSupervisor', () => {
  it('creates the models cache dir BEFORE spawning (router mode fatals on a missing --models-dir)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    expect(mockMkdir).toHaveBeenCalledWith('C:/fake/cache', { recursive: true });
    // mkdir must precede the spawn, else the fresh-install verify-boot dies.
    expect(mockMkdir.mock.invocationCallOrder[0]).toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);
  });

  it('reports a SPECIFIC error (not a bad-build guess) when the cache dir cannot be created, and does not spawn', async () => {
    mockMkdir.mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    await expect(sup.ensureRunning()).rejects.toThrow(/model folder could not be created.*EACCES/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(sup.status()).toBe('stopped');
  });

  it('surfaces the child\'s OWN output (the real cause) when it exits during startup', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 5_000 });
    const p = sup.ensureRunning();
    setImmediate(() => {
      child.stderr!.emit('data', Buffer.from(
        "failed to initialize router models: error: '/home/x/.cache/llama.cpp' does not exist or is not a directory"
      ));
      child.emit('exit', 1);
    });
    // The thrown error carries the engine's real message, NOT a hardware guess.
    await expect(p).rejects.toThrow(/does not exist or is not a directory/i);
  });

  it('ensureRunning spawns router-mode llama-server (no -m) with the pinned flag set and LLAMA_CACHE', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(20));
    const base = await sup.ensureRunning();
    expect(base).toBe('http://127.0.0.1:9999/v1');
    expect(sup.status()).toBe('running');
    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe('C:/fake/llama-server.exe');
    expect(args).toEqual([
      '--host', '127.0.0.1', '--port', '9999',
      '--no-webui', '--jinja',
      '--models-dir', 'C:/fake/cache', // discovers dropped GGUFs (LLAMA_CACHE alone doesn't)
      '--models-max', '2',
      '--sleep-idle-seconds', '300', // per-model 5-min auto-sleep (2026-07-14)
      '-c', '32768',
    ]);
    expect(args).not.toContain('-m'); // router mode = no model arg
    expect(opts.env.LLAMA_CACHE).toBe('C:/fake/cache');
  });

  it('ensureRunning is single-flight: two concurrent calls spawn once', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(30));
    const [a, b] = await Promise.all([sup.ensureRunning(), sup.ensureRunning()]);
    expect(a).toBe(b);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('rejects with a plain-language error when /health never comes up, and kills the child', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 100 });
    await expect(sup.ensureRunning()).rejects.toThrow(/did not start/i);
    expect(child.kill).toHaveBeenCalled();
    expect(sup.status()).toBe('stopped');
  });

  it('rejects when the child exits during startup', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 5_000 });
    const p = sup.ensureRunning();
    setImmediate(() => child.emit('exit', 1));
    await expect(p).rejects.toThrow(/exited/i);
    expect(sup.status()).toBe('stopped');
  });

  it('emits "crashed" on unexpected exit; the NEXT ensureRunning respawns', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    const crashSpy = vi.fn();
    sup.on('crashed', crashSpy);
    first.emit('exit', 137);
    expect(crashSpy).toHaveBeenCalledWith({ exitCode: 137 });
    expect(sup.status()).toBe('stopped');
    await sup.ensureRunning();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('strikes out after 3 crashes in 5 minutes: ensureRunning refuses until resetStrikes()', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    for (let i = 0; i < 3; i++) {
      await sup.ensureRunning();
      (mockSpawn.mock.results[mockSpawn.mock.calls.length - 1].value as any).emit('exit', 1);
    }
    expect(sup.status()).toBe('error');
    await expect(sup.ensureRunning()).rejects.toThrow(/keeps crashing/i);
    sup.resetStrikes();
    await sup.ensureRunning();
    expect(sup.status()).toBe('running');
  });

  it('idle shutdown: stops after idleMs with no requests, but NEVER mid-stream', async () => {
    vi.useFakeTimers();
    try {
      mockSpawn.mockImplementation(() => makeFakeChild());
      let releaseStream!: () => void;
      const held = new Promise<void>((r) => { releaseStream = r; });
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        const body = new ReadableStream<Uint8Array>({
          async pull(c) { await held; c.enqueue(new TextEncoder().encode('x')); c.close(); },
        });
        return new Response(body, { status: 200 });
      });
      sup = makeSupervisor(fetchImpl, { idleMs: 1_000, idleCheckMs: 100, readyPollMs: 1 });
      await sup.ensureRunning();

      const res = await sup.trackedFetch('http://127.0.0.1:9999/v1/chat/completions', {});
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sup.status()).toBe('running');

      releaseStream();
      await res.body!.getReader().read(); // drain
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('listModels: GET /models when running; cache scan shape when stopped', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        // Real b9992 shape: status is an OBJECT {value}, not a bare string.
        // Pinned by probe-models.mjs + docs/engine-dependencies.md.
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'foo-Q4_K_M', status: { value: 'loaded' } }], object: 'list' }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const models = await sup.listModels();
    expect(models).toEqual([{ id: 'foo-Q4_K_M', sizeBytes: null, loaded: true, state: 'loaded' }]);
  });

  it('listModels drops split-GGUF follower parts — one four-part set is ONE row', async () => {
    // --models-dir lists one row per FILE, so a four-part download arrives as
    // four rows. Parts 2..4 have no architecture header; selecting one 500'd
    // (2026-08-27, Qwen3.8-Flash-Next). Only part 00001 is a real model.
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004', status: { value: 'unloaded' } },
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004', status: { value: 'unloaded' } },
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004', status: { value: 'unloaded' } },
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004', status: { value: 'unloaded' } },
          { id: 'single-file-Q8_0', status: { value: 'unloaded' } },
        ] }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    expect((await sup.listModels()).map((m) => m.id)).toEqual([
      'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004',
      'single-file-Q8_0',
    ]);
  });

  it('listModels UNIONS the disk scan into GET /models — a GGUF downloaded after boot is listed without a restart (Amendment K2)', async () => {
    // Real temp cache dir: fs.readdirSync/statSync are NOT mocked (only
    // mkdirSync is), so scanGgufCache reads real files dropped here.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const os = await import('os');
    const path = await import('path');
    const cacheDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'k2-cache-'));
    try {
      mockSpawn.mockReturnValue(makeFakeChild());
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        if (String(url).endsWith('/models')) {
          // The router only knows what it discovered at BOOT.
          return { ok: true, status: 200, json: async () => ({ data: [{ id: 'boot-model-Q4_K_M', status: { value: 'loaded' } }] }) } as any;
        }
        return { ok: false, status: 404 } as any;
      });
      sup = makeSupervisor(fetchImpl, { cacheDir });
      await sup.ensureRunning();
      // Simulate a download finishing AFTER boot: the file just appears on disk.
      realFs.writeFileSync(path.join(cacheDir, 'boot-model-Q4_K_M.gguf'), Buffer.alloc(4));
      realFs.writeFileSync(path.join(cacheDir, 'downloaded-later-Q4_K_M.gguf'), Buffer.alloc(8));
      const byId = Object.fromEntries((await sup.listModels()).map((m) => [m.id, m]));
      // The router's row wins for the model it knows (live residency state)…
      expect(byId['boot-model-Q4_K_M']).toMatchObject({ state: 'loaded', sizeBytes: 4 });
      // …and the post-boot download is unioned in from the scan as 'unloaded'.
      expect(byId['downloaded-later-Q4_K_M']).toMatchObject({ state: 'unloaded', loaded: false, sizeBytes: 8 });
    } finally {
      realFs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('listModels maps /models status.value → EngineModelState (unknown → unloaded)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [
          { id: 'a', status: { value: 'loaded' } },
          { id: 'b', status: { value: 'sleeping' } },
          { id: 'c', status: { value: 'loading' } },
          { id: 'd', status: { value: 'unloaded' } },
          { id: 'e', status: { value: 'some-future-state' } },
        ] }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const byId = Object.fromEntries((await sup.listModels()).map((m) => [m.id, m.state]));
    expect(byId).toEqual({ a: 'loaded', b: 'sleeping', c: 'loading', d: 'unloaded', e: 'unloaded' });
  });

  it('emits models-changed after boot with the live model set (drives the per-session banner)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a', status: { value: 'loaded' } }] }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    const changed: any[] = [];
    sup.on('models-changed', (m) => changed.push(m));
    await sup.ensureRunning();
    await new Promise((r) => setTimeout(r, 30)); // let the initial poll tick resolve
    expect(changed.length).toBeGreaterThan(0);
    expect(changed[changed.length - 1][0]).toMatchObject({ id: 'a', state: 'loaded' });
  });

  it('ensureRunning during an in-flight stop WAITS for it, then respawns (no URL to the dying server)', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    // Make the first child's kill NOT exit immediately, so stop() stays
    // in-flight and we can probe ensureRunning during the teardown window.
    let releaseExit!: () => void;
    (first as any).kill = vi.fn(() => {
      new Promise<void>((r) => { releaseExit = r; }).then(() => first.emit('exit', 0));
      return true;
    });
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    expect(sup.status()).toBe('running');

    const stopP = sup.stop();          // in-flight until releaseExit()
    const ensureP = sup.ensureRunning(); // must NOT resolve with the old URL yet
    let ensured = false;
    void ensureP.then(() => { ensured = true; });
    await Promise.resolve();
    expect(ensured).toBe(false);        // still waiting for the stop to finish

    releaseExit();                      // stop completes → ensureRunning respawns
    await stopP;
    await ensureP;
    expect(mockSpawn).toHaveBeenCalledTimes(2); // spawned a fresh server, didn't reuse the dying one
    expect(sup.status()).toBe('running');
  });

  // ---- engine-lifecycle fix (2026-07-20): no adopting orphans, real quit kill ----

  it('does NOT adopt a foreign process answering /health on our port (orphan guard)', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    // /health answers ok immediately, but the port is held by a DIFFERENT pid (9999) —
    // an orphaned engine. The supervisor must NOT mark running against it; our child
    // (which couldn't bind) exits, so we surface the startup failure instead.
    sup = makeSupervisor(healthAfter(0), {
      pidOnPort: () => 9999, // foreign listener
      readyDeadlineMs: 500, readyPollMs: 10,
    });
    const p = sup.ensureRunning();
    setImmediate(() => child.emit('exit', 1)); // bind-failed child dies
    await expect(p).rejects.toThrow();          // never resolves a URL to the orphan
    expect(sup.status()).toBe('stopped');
  });

  it('DOES mark running when the /health listener IS our spawned child', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(healthAfter(0), { pidOnPort: () => 4242 }); // our own child
    const base = await sup.ensureRunning();
    expect(base).toBe('http://127.0.0.1:9999/v1');
    expect(sup.status()).toBe('running');
  });

  it('reaps a stale llama-server squatting on the port BEFORE spawning', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // Port is held by orphan pid 9999 (a llama-server). After the reaper SIGKILLs it,
      // our spawned child (4242) takes the port — pidOnPort reflects the handoff.
      let portHolder: number | null = 9999;
      killSpy.mockImplementation(((pid: number, sig: string) => {
        if (pid === 9999 && sig === 'SIGKILL') portHolder = 4242;
        return true;
      }) as any);
      sup = makeSupervisor(healthAfter(0), {
        pidOnPort: () => portHolder,
        exeForPid: (pid: number) => (pid === 9999 ? '/x/engine/llama-b9992/llama-server' : null),
      });
      const base = await sup.ensureRunning();
      expect(killSpy).toHaveBeenCalledWith(9999, 'SIGKILL'); // orphan reaped before spawn
      expect(base).toBe('http://127.0.0.1:9999/v1');          // then our child is adopted
      expect(sup.status()).toBe('running');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('never kills a NON-llama process holding the port (reaper is conservative)', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // Port held by pid 9999, but it's some other app (not llama-server) — must NOT kill.
      sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), {
        pidOnPort: () => 9999,
        exeForPid: () => '/usr/bin/nginx',
        readyDeadlineMs: 100, readyPollMs: 10,
      });
      await expect(sup.ensureRunning()).rejects.toThrow();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('stop() escalates SIGTERM → SIGKILL when the child ignores TERM', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      // Child ignores SIGTERM entirely (never exits on it) — simulates a wedged server.
      const killCalls: string[] = [];
      (child as any).kill = vi.fn((sig: string) => {
        killCalls.push(sig);
        if (sig === 'SIGKILL') setImmediate(() => child.emit('exit', 137));
        return true;
      });
      mockSpawn.mockReturnValue(child);
      sup = makeSupervisor(healthAfter(0));
      await sup.ensureRunning();
      expect(sup.status()).toBe('running');

      const stopP = sup.stop();
      await vi.advanceTimersByTimeAsync(1_600); // past the TERM grace window
      await vi.advanceTimersByTimeAsync(100);   // let the KILL exit land
      await stopP;
      expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- cross-platform port→PID parsers (pure; no shell) ----
// These pin the output shapes of the per-platform tools the orphan-guard and
// stale-engine reaper rely on, so a parsing regression can't silently re-open
// the "adopt a foreign engine" hole on macOS/Windows.
describe('port→PID parsers', () => {
  it('parseSsListenerPid: Linux ss -ltnp output → PID', () => {
    const out = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0      511    127.0.0.1:9920      0.0.0.0:*     users:(("llama-server",pid=111523,fd=20))',
      'LISTEN 0      511    127.0.0.1:9900      0.0.0.0:*     users:(("node",pid=777,fd=25))',
    ].join('\n');
    expect(parseSsListenerPid(out, 9920)).toBe(111523);
    expect(parseSsListenerPid(out, 9900)).toBe(777);
    expect(parseSsListenerPid(out, 1234)).toBeNull(); // not listening
    // Exact-match: a query for a PREFIX port must not match a longer listening port.
    expect(parseSsListenerPid(out, 992)).toBeNull();  // ':992' ≠ ':9920'
    expect(parseSsListenerPid(out, 99)).toBeNull();   // ':99'  ≠ ':9900'/':9920'
  });

  it('parseLsofPid: macOS lsof -F p output → PID', () => {
    expect(parseLsofPid('p4821\nf3\n')).toBe(4821);
    expect(parseLsofPid('')).toBeNull();
    expect(parseLsofPid('COMMAND  PID USER\n')).toBeNull();
  });

  it('parseNetstatListenerPid: Windows netstat -ano → PID of LISTENING socket', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:9920         0.0.0.0:0              LISTENING       22234',
      '  TCP    127.0.0.1:9920         127.0.0.1:55000        ESTABLISHED     999', // not LISTENING — ignored
      '  TCP    0.0.0.0:9900           0.0.0.0:0              LISTENING       5555',
    ].join('\n');
    expect(parseNetstatListenerPid(out, 9920)).toBe(22234);
    expect(parseNetstatListenerPid(out, 9900)).toBe(5555);
    expect(parseNetstatListenerPid(out, 4321)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Router rescan (GET /models?reload=1). The router discovers GGUFs at BOOT and
// re-scans --models-dir ONLY when asked: its need_reload dirty flag is set just
// for downloads the ROUTER itself started, and ours are app-side. Verified
// against b9992 (libllama-server-impl.so + upstream tools/server/server-models.cpp)
// on 2026-08-16, after a real send 400'd on a model that had been on disk for
// half an hour. Depth: docs/engine-dependencies.md.
// ---------------------------------------------------------------------------
describe('EngineSupervisor — router rescan', () => {
  /** fetch stub whose router-known model set can be swapped mid-test. */
  function routerWith(known: string[]) {
    const state = { known: [...known] };
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.slice(u.indexOf('/', 8))}`);
      if (u.endsWith('/health')) return { ok: true, status: 200 } as any;
      if (u.includes('/models')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: state.known.map((id) => ({ id, status: { value: 'unloaded' } })) }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    return { fetchImpl, calls, state };
  }

  const reloadCalls = (calls: string[]) => calls.filter((c) => c.includes('reload'));

  it('refreshModels asks the router to re-scan: GET /models?reload=1', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls } = routerWith(['boot-model-Q4_K_M']);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    await sup.refreshModels();
    expect(reloadCalls(calls)).toEqual(['GET /models?reload=1']);
  });

  it('refreshModels is a no-op when the engine is not running (the next boot scans the dir anyway)', async () => {
    const { fetchImpl, calls } = routerWith([]);
    sup = makeSupervisor(fetchImpl);
    await sup.refreshModels();
    expect(calls).toEqual([]);
  });

  // The load-bearing guard. reload=1 is a WRITE: upstream load_models() unloads a
  // running model whose source changed or vanished. On a 1.5s poll that would be a
  // reconciliation pass every tick, forever.
  it('the background model poll NEVER sends reload=1', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls } = routerWith(['a-Q4_K_M']);
    sup = makeSupervisor(fetchImpl, { modelPollMs: 5, modelPollLoadingMs: 5 });
    await sup.ensureRunning();
    await new Promise((r) => setTimeout(r, 60)); // several poll ticks
    expect(calls.filter((c) => c.includes('/models')).length).toBeGreaterThan(1); // it really did poll
    expect(reloadCalls(calls)).toEqual([]);
  });

  it('ensureServable does NOT re-scan when the router already serves the model', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls } = routerWith(['boot-model-Q4_K_M']);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    expect(await sup.ensureServable('boot-model-Q4_K_M')).toBe(true);
    expect(reloadCalls(calls)).toEqual([]);
  });

  it('ensureServable re-scans when the model is on disk but unknown to the router, and reports it servable', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls, state } = routerWith(['boot-model-Q4_K_M']);
    // The rescan is what makes the post-boot download visible to the router.
    fetchImpl.mockImplementation((async (url: string, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.slice(u.indexOf('/', 8))}`);
      if (u.endsWith('/health')) return { ok: true, status: 200 } as any;
      if (u.includes('/models')) {
        if (u.includes('reload')) state.known.push('downloaded-later-Q4_K_M');
        return {
          ok: true, status: 200,
          json: async () => ({ data: state.known.map((id) => ({ id, status: { value: 'unloaded' } })) }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    expect(await sup.ensureServable('downloaded-later-Q4_K_M')).toBe(true);
    expect(reloadCalls(calls)).toEqual(['GET /models?reload=1']);
  });

  it('ensureServable reports FALSE when even a re-scan does not surface the model', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl } = routerWith(['boot-model-Q4_K_M']);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    // No lie: the caller needs a real answer so it can say something accurate.
    expect(await sup.ensureServable('never-existed-Q4_K_M')).toBe(false);
  });

  it('ensureServable re-scans at most once for concurrent callers (single-flight)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls, state } = routerWith(['boot-model-Q4_K_M']);
    fetchImpl.mockImplementation((async (url: string, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.slice(u.indexOf('/', 8))}`);
      if (u.endsWith('/health')) return { ok: true, status: 200 } as any;
      if (u.includes('/models')) {
        if (u.includes('reload')) {
          await new Promise((r) => setTimeout(r, 20)); // a real scan takes a beat
          if (!state.known.includes('downloaded-later-Q4_K_M')) state.known.push('downloaded-later-Q4_K_M');
        }
        return {
          ok: true, status: 200,
          json: async () => ({ data: state.known.map((id) => ({ id, status: { value: 'unloaded' } })) }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const all = await Promise.all([
      sup.ensureServable('downloaded-later-Q4_K_M'),
      sup.ensureServable('downloaded-later-Q4_K_M'),
      sup.ensureServable('downloaded-later-Q4_K_M'),
    ]);
    expect(all).toEqual([true, true, true]);
    expect(reloadCalls(calls)).toEqual(['GET /models?reload=1']);
  });

  it('ensureServable does not block a send when the router is unreachable — it assumes servable', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      throw new Error('ECONNRESET');
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    // Failing OPEN is deliberate: a probe that can't answer must not be the thing
    // that stops a send the engine would have served fine.
    expect(await sup.ensureServable('boot-model-Q4_K_M')).toBe(true);
  });
});
