import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { EngineSupervisor } from '../src/main/engine/engine-supervisor';

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
