import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeService } from '../src/main/opencode-service';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const mockSdkConstructor = vi.fn();
// Production resolves @opencode-ai/sdk via a Function-constructor trick that
// bypasses vitest's `vi.mock` mocker. We inject the SDK module via the
// `sdkLoader` option in OpenCodeServiceOpts instead.
const mockSdkLoader = () => Promise.resolve({
  createOpencodeClient: (opts: any) => mockSdkConstructor(opts),
});

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn();
  ee.pid = 12345;
  return ee;
}

describe('OpenCodeService', () => {
  let svc: OpenCodeService;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockSdkConstructor.mockReset();
  });

  afterEach(async () => { await svc?.stop(); });

  // Note: ready-detection is by polling the configured port, not by parsing
  // stdout. This is more robust against OpenCode log-format changes between
  // versions. Tests inject a fake fetch that "becomes reachable" after a
  // controlled delay.

  function makeReachableAfter(delayMs: number): ReturnType<typeof vi.fn> {
    const start = Date.now();
    return vi.fn(async () => {
      if (Date.now() - start < delayMs) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: true, status: 200 } as Response;
    });
  }

  it('start() spawns "opencode serve --port N" and resolves once the port becomes reachable', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fakeChild);
    const fetchMock = makeReachableAfter(50);

    svc = new OpenCodeService({ binaryPath: '/usr/local/bin/opencode', fetchImpl: fetchMock as any, sdkLoader: mockSdkLoader });
    await svc.start();

    expect(svc.isRunning()).toBe(true);
    expect(svc.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/local/bin/opencode',
      expect.arrayContaining(['serve', '--port', expect.any(String)]),
      expect.any(Object),
    );
  });

  it('start() rejects if the port never becomes reachable within the deadline', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });

    svc = new OpenCodeService({
      binaryPath: '/usr/local/bin/opencode',
      fetchImpl: fetchMock as any,
      readyDeadlineMs: 200,   // short for tests
      sdkLoader: mockSdkLoader,
    });

    await expect(svc.start()).rejects.toThrow(/did not become reachable/);
    expect(svc.isRunning()).toBe(false);
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it('start() rejects if the child exits before becoming reachable', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });

    svc = new OpenCodeService({
      binaryPath: '/usr/local/bin/opencode',
      fetchImpl: fetchMock as any,
      readyDeadlineMs: 5000,
      sdkLoader: mockSdkLoader,
    });
    const startP = svc.start();
    setImmediate(() => fakeChild.emit('exit', 1));

    await expect(startP).rejects.toThrow();
    expect(svc.isRunning()).toBe(false);
  });

  it('stop() kills the child process and clears state', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fakeChild);
    const fetchMock = makeReachableAfter(20);

    svc = new OpenCodeService({ binaryPath: '/usr/local/bin/opencode', fetchImpl: fetchMock as any, sdkLoader: mockSdkLoader });
    await svc.start();
    await svc.stop();
    expect(fakeChild.kill).toHaveBeenCalled();
    expect(svc.isRunning()).toBe(false);
  });

  it('emits "crashed" if the child exits unexpectedly while running', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fakeChild);
    const fetchMock = makeReachableAfter(20);

    svc = new OpenCodeService({ binaryPath: '/usr/local/bin/opencode', fetchImpl: fetchMock as any, sdkLoader: mockSdkLoader });
    await svc.start();

    const crashSpy = vi.fn();
    svc.on('crashed', crashSpy);
    fakeChild.emit('exit', 137);
    expect(crashSpy).toHaveBeenCalledWith({ exitCode: 137 });
    expect(svc.isRunning()).toBe(false);
  });
});
