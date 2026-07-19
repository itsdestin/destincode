// Pins the native session-meta refusal (stopgap, 2026-07-19).
//
// Background: flags/tags/notes live in the Conversation Store, which has no
// record shape for native sessions yet. A gate added 2026-07-18 correctly
// stopped the WRITE (it was seeding mislabeled provider:'claude' phantoms) but
// the handlers still returned { ok: true } and still broadcast
// session:meta-changed — so the renderer's optimistic update stuck and the user
// believed the edit had saved until the next browse. Silent data loss.
//
// These tests pin the two halves of the fix that are easy to regress:
//   1. a NATIVE id is refused explicitly (ok:false + unsupported) and does NOT
//      broadcast, and get-meta reports supported:false;
//   2. a CLAUDE CODE id is completely unaffected — in particular the pre-existing
//      "live session before its SessionStart hook maps" case must still answer
//      ok:true, because that flag legitimately re-applies once the mapping lands.
//      Turning that into a visible failure would be a real regression.
//
// Retire alongside the gate when native-sync-parity lands (v1.3.1 —
// docs/active/specs/2026-07-18-native-sync-parity-design.md).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
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

import { registerIpcHandlers } from '../src/main/ipc-handlers';

// A persisted native session is one with a file at
// <home>/.youcoded/sessions/<slug>/<sessionId>.jsonl — that's exactly what
// SessionStore.has() scans, and what NativeSessionHost.isNativeSessionId()
// consults for a session that is NOT currently live.
const NATIVE_ID = '11111111-2222-3333-4444-555555555555';
const CC_ID = '99999999-8888-7777-6666-555555555555';

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let mockWindow: { webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed: () => boolean };

function setup(sessionManagerOverrides: Record<string, unknown> = {}) {
  const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
  const mockSessionManager = {
    createSession: vi.fn(),
    destroySession: vi.fn(() => true),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => undefined),
    sendInput: vi.fn(),
    resizeSession: vi.fn(),
    on: vi.fn(),
    ...sessionManagerOverrides,
  };
  mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(),
    installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(),
    ensureMigrated: vi.fn(),
  };
  registerIpcHandlers(
    mockIpcMain as any,
    mockSessionManager as any,
    mockWindow as any,
    mockSkillProvider as any,
  );
  const handler = (channel: string) =>
    (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === channel)[1];
  return { handler, mockWindow };
}

// One home for the whole file, torn down once at the end. registerIpcHandlers
// kicks off background init (ProviderRegistry.init → writes ~/.youcoded) that no
// test awaits, so deleting the dir per-test raced those writes and surfaced as
// unhandled ENOENT rejections. A single dir plus a flush before removal avoids it.
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-native-meta-'));
  // Redirect the home via $HOME rather than vi.spyOn(os, 'homedir'):
  // native-home.ts does `import * as os`, and the spy does NOT reach that
  // namespace binding — it left the fixture invisible, so every "native"
  // assertion silently exercised the CC path instead. os.homedir() consults
  // $HOME on POSIX, which does reach it. USERPROFILE is the Windows equivalent
  // and MUST be set too — desktop CI runs this suite on windows-latest, where
  // $HOME alone leaves the fixture invisible and the native assertions all fail.
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  // The fixture tree is deliberately NOT removed. registerIpcHandlers starts
  // background init (ProviderRegistry.init → writes ~/.youcoded/providers.json)
  // that nothing exposes a handle to await, so deleting the tree races those
  // writes and they surface as unhandled ENOENT rejections — which vitest fails
  // the run on even though every test passed. A timed flush only hid it on fast
  // machines; it went red on the macOS runner. Leaving one small mkdtemp dir per
  // run in the OS temp area is the deterministic trade.
});

beforeEach(() => {
  const slugDir = path.join(tmpHome, '.youcoded', 'sessions', 'test-project');
  fs.mkdirSync(slugDir, { recursive: true });
  // Only the FILENAME matters for has() — it never reads contents (deliberately,
  // so the gate doesn't pay a head-read per session). A header line is written
  // anyway so the fixture resembles a real session file.
  fs.writeFileSync(
    path.join(slugDir, `${NATIVE_ID}.jsonl`),
    JSON.stringify({ v: 1, sessionId: NATIVE_ID, cwd: '/tmp/test-project' }) + '\n',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session meta — native sessions are refused, not silently dropped', () => {
  it('session:set-flag returns ok:false with unsupported and does NOT broadcast', async () => {
    const { handler, mockWindow } = setup();
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, NATIVE_ID, 'complete', true);

    expect(res.ok).toBe(false);
    expect(res.unsupported).toBe(true);
    expect(typeof res.error).toBe('string');
    // The broadcast is the part that made the old behavior convincing: listeners
    // refetched and "confirmed" a change that never happened.
    const metaBroadcasts = mockWindow.webContents.send.mock.calls
      .filter((c: any[]) => c[0] === 'session:meta-changed');
    expect(metaBroadcasts).toHaveLength(0);
  });

  it('session:set-tag is refused', async () => {
    const { handler } = setup();
    const res = await handler('session:set-tag')({ sender: { id: 1 } }, NATIVE_ID, 'tag_abc', true);
    expect(res.ok).toBe(false);
    expect(res.unsupported).toBe(true);
  });

  it('session:set-note is refused', async () => {
    const { handler } = setup();
    const res = await handler('session:set-note')({ sender: { id: 1 } }, NATIVE_ID, 'hello');
    expect(res.ok).toBe(false);
    expect(res.unsupported).toBe(true);
  });

  it('session:get-meta reports supported:false so the UI can disable up front', async () => {
    const { handler } = setup();
    const meta = await handler('session:get-meta')({ sender: { id: 1 } }, NATIVE_ID);
    expect(meta.supported).toBe(false);
    expect(meta.tags).toEqual([]);
    expect(meta.note).toBe('');
  });
});

describe('session meta — Claude Code sessions are unaffected', () => {
  it('set-flag on a CC id still succeeds', async () => {
    const { handler } = setup();
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, CC_ID, 'complete', true);
    expect(res.ok).toBe(true);
    expect(res.unsupported).toBeUndefined();
  });

  it('set-flag on a LIVE CC session with no hook mapping yet still returns ok:true', async () => {
    // The pre-existing phantom-record gate skips the store WRITE here (the
    // desktop id isn't mapped to a claude id yet), but the flag re-applies once
    // the SessionStart hook lands the mapping — so this must NOT surface as a
    // failure the renderer reverts. Regression guard for the stopgap.
    const { handler } = setup({
      getSession: vi.fn(() => ({ id: CC_ID, name: 'live', cwd: '/tmp', status: 'active' })),
    });
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, CC_ID, 'priority', true);
    expect(res.ok).toBe(true);
    expect(res.unsupported).toBeUndefined();
  });

  it('get-meta on a CC id reports supported:true', async () => {
    const { handler } = setup();
    const meta = await handler('session:get-meta')({ sender: { id: 1 } }, CC_ID);
    expect(meta.supported).toBe(true);
  });

  it('an unknown flag name is still rejected before the native check', async () => {
    const { handler } = setup();
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, NATIVE_ID, 'bogus', true);
    expect(res.ok).toBe(false);
    // Validation error, not the native refusal — ordering matters so a typo
    // surfaces as a typo even on a native session.
    expect(res.unsupported).toBeUndefined();
    expect(res.error).toContain('bogus');
  });
});
