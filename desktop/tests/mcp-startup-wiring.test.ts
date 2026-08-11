// Task 7b pinning test: proves the McpManager constructed in ipc-handlers.ts
// is REACHABLE, not just constructed. Task 6 already proved (in
// native-session-host.test.ts) that a WIRED manager's acquire() output
// becomes a session's tools; what was still unproven — the exact gap the
// task-7b brief describes — is that ipc-handlers.ts ever builds a real
// manager, backed by the real registry/nativeHome/secretsStore, and hands
// THAT SAME INSTANCE into NativeSessionHost's constructor. A test that only
// checks "new McpManager was called" would pass even if the manager were
// discarded immediately after construction — this test instead writes a real
// ~/.youcoded/mcp.json, captures the exact manager instance handed to
// NativeSessionHost, and calls its real acquire() to confirm the configured
// server comes back out the other end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The connectionFactory is the one seam every existing MCP test fakes
// (mcp-client.test.ts fakes the SDK's clientFactory; mcp-manager.test.ts
// fakes connectionFactory directly) rather than spawning a real subprocess.
// Mocking mcp-client's createConnection here keeps that same convention while
// still proving ipc-handlers wires THAT module's export (not a homemade
// stand-in) as the manager's connectionFactory: the mock only replaces the
// connection's behavior, not which function ipc-handlers imports and passes.
const createConnectionMock = vi.fn((server: { id: string }) => ({
  state: 'ready' as const,
  lastError: null,
  connect: async () => {},
  listTools: () => [{ name: 'demo_tool', description: 'd', inputSchema: { type: 'object' } }],
  callTool: async () => ({ text: 'ok', isError: false }),
  close: async () => {},
}));
vi.mock('../src/main/harness/mcp/mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/harness/mcp/mcp-client')>();
  return { ...actual, createConnection: createConnectionMock };
});

// Captures the real args NativeSessionHost's constructor receives, WITHOUT
// changing its behavior (extends + delegates to the real class via super()).
// This is the only way to inspect ipc-handlers' positional 10th argument
// (mcpManager, shifted from 9th by Task 6c's new visionSupportFor param)
// without exporting it or refactoring the constructor shape — the brief
// explicitly forbids the latter.
let capturedCtorArgs: unknown[] | undefined;
vi.mock('../src/main/harness/native-session-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/harness/native-session-host')>();
  class SpyNativeSessionHost extends actual.NativeSessionHost {
    constructor(...args: unknown[]) {
      // @ts-expect-error — spread into the real (positional) constructor
      super(...args);
      capturedCtorArgs = args;
    }
  }
  return { ...actual, NativeSessionHost: SpyNativeSessionHost };
});

// NativeHome defaults to os.homedir() (see native-home.ts) and ipc-handlers.ts
// constructs `new NativeHome()` with no override — so redirecting os.homedir()
// is what makes the test hit the SAME ~/.youcoded/mcp.json path production
// code reads, rather than faking NativeHome's internals.
let testHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => testHome };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => testHome),
    getVersion: vi.fn(() => '0.0.0-test'),
    whenReady: vi.fn(() => new Promise(() => {})),
    on: vi.fn(),
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    getGPUInfo: vi.fn(() => new Promise(() => {})),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } })),
  Menu: { setApplicationMenu: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
  nativeImage: {},
  shell: { openExternal: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
}));

function makeMockIpcMain() {
  return { handle: vi.fn(), on: vi.fn() };
}
function makeMockSessionManager() {
  return {
    createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
    destroySession: vi.fn(() => true),
    listSessions: vi.fn(() => []),
    sendInput: vi.fn(),
    resizeSession: vi.fn(),
    on: vi.fn(),
  };
}
function makeMockSkillProvider() {
  return {
    configStore: { getPackages: vi.fn(() => ({})) },
    getInstalled: vi.fn(() => []),
    listMarketplace: vi.fn(() => []),
    getSkillDetail: vi.fn(),
    search: vi.fn(() => []),
    install: vi.fn(),
    uninstall: vi.fn(),
    getFavorites: vi.fn(() => []),
    setFavorite: vi.fn(),
    getChips: vi.fn(() => []),
    setChips: vi.fn(),
    getOverrides: vi.fn(() => ({})),
    setOverride: vi.fn(),
    createPromptSkill: vi.fn(),
    deletePromptSkill: vi.fn(),
    publish: vi.fn(),
    generateShareLink: vi.fn(),
    importFromLink: vi.fn(),
    getCuratedDefaults: vi.fn(() => []),
  };
}

describe('McpManager startup wiring (Task 7b)', () => {
  beforeEach(() => {
    // Deliberately NOT cleaned up in afterEach: ipc-handlers.ts also fires
    // ProviderRegistry.init() fire-and-forget (unrelated to MCP, pre-existing
    // behavior), which writes into this same homedir sometime after the test
    // body returns — removing the directory immediately would race that write
    // and surface as a spurious unhandled rejection. A handful of leftover
    // temp dirs under the OS tmpdir is a fine trade for a deterministic test.
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-mcp-wiring-'));
    capturedCtorArgs = undefined;
    createConnectionMock.mockClear();
  });

  it('threads a REAL, config-driven McpManager into NativeSessionHost as the 10th positional arg', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'mcp.json'),
      JSON.stringify({
        servers: [
          { id: 'demo', label: 'Demo Server', enabled: true, transport: { type: 'stdio', command: 'node' }, origin: { kind: 'user' } },
        ],
      }),
    );

    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    expect(capturedCtorArgs).toBeDefined();
    // Positional shape pinned by the brief: 10 args (Task 6c added
    // visionSupportFor as the 3rd positional param, shifting everything after
    // providerTypeFor down by one), skillCatalog (index 8) explicitly
    // undefined so mcpManager (index 9) lands in the right slot.
    expect(capturedCtorArgs!.length).toBe(10);
    expect(capturedCtorArgs![8]).toBeUndefined();

    const mcpManager = capturedCtorArgs![9] as {
      acquire(sessionId: string): Promise<{ servers: Array<{ id: string; label: string; tools: unknown[] }> }>;
    };
    expect(mcpManager).toBeDefined();
    expect(typeof mcpManager.acquire).toBe('function');

    // The real test: acquire() actually reads the hand-written mcp.json and
    // returns the configured server — this is the exact call NativeSessionHost
    // makes per-session (Task 6). If the wiring were removed (mcpManager left
    // undefined, or the registry pointed elsewhere), this would throw or
    // return [].
    const { servers: ready } = await mcpManager.acquire('test-session');
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('demo');
    expect(ready[0].label).toBe('Demo Server');
    expect(ready[0].tools).toEqual([{ name: 'demo_tool', description: 'd', inputSchema: { type: 'object' } }]);

    // Confirms the factory ipc-handlers wired really is mcp-client's
    // createConnection (this file's export, not a duplicate), invoked with
    // the resolved server read from disk.
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(createConnectionMock.mock.calls[0][0]).toMatchObject({ id: 'demo' });
  });

  it('a user with no ~/.youcoded/mcp.json gets a silent no-op manager — no directory, no subprocess, no error', async () => {
    // Deliberately do NOT create .youcoded/ or mcp.json — this is the normal
    // case for almost every install (brief: "must be silent and
    // side-effect-free for them").
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    // MCP construction alone must not write mcp.json (or create it fresh) —
    // McpRegistry.list()/resolveAllEnabled() only ever READ. (The .youcoded
    // dir itself may already exist because of ProviderRegistry's own
    // fire-and-forget init() write, which is unrelated to MCP and out of
    // this task's scope — so this asserts the MCP-specific file, not the
    // shared directory.)
    expect(fs.existsSync(path.join(testHome, '.youcoded', 'mcp.json'))).toBe(false);

    const mcpManager = capturedCtorArgs![9] as { acquire(sessionId: string): Promise<{ servers: unknown[] }> };
    const { servers: ready } = await mcpManager.acquire('test-session');
    expect(ready).toEqual([]);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });
});
