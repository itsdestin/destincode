// Pins the three split-refusal messages of the native resume path
// (ipc-handlers.ts session:create, Task 9). ROADMAP 2026-07-23: this branch
// predates M2 and had no direct test — the only prior coverage was
// message-agnostic and touched one branch incidentally. Each case drives the
// REAL handler with a REAL conversation store and asserts the EXACT copy, so
// a wording collapse or branch swap fails loudly.
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
import { startConversationStore, stopConversationStore, getConversationStore } from '../src/main/conversations/service';

let tmpHome: string;
let tmpConvRoot: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

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
  const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
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

// One home for the whole file — see session-meta-native-refusal.test.ts's (now
// deleted) rationale for why: registerIpcHandlers kicks off background init
// (ProviderRegistry.init → writes ~/.youcoded) that no test awaits, so deleting
// the dir per-test raced those writes and surfaced as unhandled ENOENT
// rejections. A single dir plus no mid-run deletion avoids it.
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-'));
  // Redirect the home via $HOME rather than vi.spyOn(os, 'homedir'):
  // native-home.ts does `import * as os`, and the spy does NOT reach that
  // namespace binding — it left the fixture invisible. USERPROFILE is the
  // Windows equivalent and MUST be set too (desktop CI runs windows-latest).
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  // Deliberately not removed — see the native-refusal test's same note: nothing
  // exposes a handle to await ProviderRegistry.init()'s background writes.
});

beforeEach(async () => {
  // Unlike session-meta-parity.test.ts, this file does NOT write a native
  // transcript jsonl here — the whole point of these cases is that RESUME_ID's
  // transcript is absent under the redirected home.
  tmpConvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-store-'));
  // REAL store (design's acceptance: a fake would let a write-to-wrong-bucket
  // regression pass). noteFlagChanged/noteSessionNote buffer until the store
  // settles 'ready'/'unavailable' (conversations/service.ts) — awaiting start
  // here means every call in a test sees the fast 'ready' path.
  await startConversationStore({
    conversationsRoot: tmpConvRoot,
    projectsDir: path.join(tmpHome, '.claude', 'projects'),
    topicsDir: path.join(tmpHome, '.claude', 'topics'),
    device: 'test-device',
  });
});

afterEach(() => {
  stopConversationStore();
  vi.restoreAllMocks();
  try { fs.rmSync(tmpConvRoot, { recursive: true, force: true }); } catch {}
});

const RESUME_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function createNativeResume(handler: any, cwd?: string) {
  await handler('session:create')(
    { sender: { id: 1 } },
    { provider: 'native', resumeSessionId: RESUME_ID, cwd, name: 'Resuming…', skipPermissions: false },
  );
  // Refusals emit via process.nextTick — flush one tick before asserting.
  await new Promise((resolve) => process.nextTick(resolve));
}

function sessionErrorText(mockWindow: any): string | undefined {
  const call = mockWindow.webContents.send.mock.calls.find(
    (c: any[]) => c[0] === 'transcript:event' && c[1]?.type === 'session-error' && c[1]?.sessionId === RESUME_ID,
  );
  return call?.[1]?.data?.text;
}

describe('session:create native resume — split refusal messages', () => {
  it("refuses with the 'hasn't synced' message when the folder resolves but its transcript is absent", async () => {
    const { handler, mockWindow } = setup({
      createSession: vi.fn(() => ({ id: RESUME_ID, name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
    });
    // Record resolves via originalPath (an existing dir) but NO
    // <home>/.youcoded/sessions/<slug>/<id>.jsonl exists for that dir.
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-proj-'));
    await getConversationStore()!.upsert({
      provider: 'native', id: RESUME_ID,
      projectName: path.basename(projDir), originalPath: projDir,
    });
    await createNativeResume(handler, '/nonexistent-cwd');
    expect(sessionErrorText(mockWindow)).toBe(
      "This conversation hasn't synced to this device yet — its transcript isn't here.",
    );
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("refuses with the 'project folder isn't on this device' message when nothing resolves the record", async () => {
    const { handler, mockWindow } = setup({
      createSession: vi.fn(() => ({ id: RESUME_ID, name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
    });
    // originalPath does not exist; projectName matches no managed root or
    // saved folder under the redirected HOME → resolver returns null.
    await getConversationStore()!.upsert({
      provider: 'native', id: RESUME_ID,
      projectName: 'no-such-project-anywhere', originalPath: '/definitely/not/here',
    });
    await createNativeResume(handler, '/nonexistent-cwd');
    expect(sessionErrorText(mockWindow)).toBe(
      "This conversation's project folder ('no-such-project-anywhere') isn't on this device.",
    );
  });

  it("refuses with the 'saved data is missing' message when there is no record and no binding", async () => {
    const { handler, mockWindow } = setup({
      createSession: vi.fn(() => ({ id: RESUME_ID, name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
    });
    // No store record, cwd fails existsSync, no binding → resume() false path.
    await createNativeResume(handler, '/nonexistent-cwd');
    expect(sessionErrorText(mockWindow)).toBe(
      'This conversation could not be resumed — its saved data is missing.',
    );
  });
});
