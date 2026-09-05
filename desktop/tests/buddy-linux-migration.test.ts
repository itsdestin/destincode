// @vitest-environment jsdom
//
// R12 + R13 of the Linux buddy helper contract
// (docs/active/design/2026-09-04-linux-buddy-helper/, §6).
//
// R12: "If your buddy is already on, it is hidden after the update until you turn
// it back on." R13: "The offer to add the helper waits in the buddy's settings; no
// dialog interrupts you after an update."
//
// The hazards this file pins, all of which a user would notice:
//  · running twice — the buddy the user just switched back on disappears again;
//  · running in the buddy's OWN windows, which share the same localStorage;
//  · running on a phone or a remote browser, where there is no buddy and every
//    buddy method throws;
//  · running AFTER the launch path reads the preference, which would re-open the
//    stuck buddy this migration exists to hide.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom in this suite ships NO localStorage — `window.localStorage` is undefined
// (the gap tests/app-resume-session-listener.test.ts already ran into), and on
// Node 26 the bare `localStorage` global is the runtime's own, disabled unless
// --localstorage-file is passed. The migration is a localStorage one-shot, so the
// test supplies a real one rather than mocking the thing under test.
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    value: localStorageShim, configurable: true, writable: true,
  });
}

type Calls = { show: number; helperStatus: number; installHelper: number; getPlatform: number };

/** The Electron-shaped bridge. `window` (window controls) is the marker the boot
 *  path uses to tell a real desktop app from a remote browser or Android. */
function installFakeClaude(platform: string, opts: { electron?: boolean } = {}): Calls {
  const calls: Calls = { show: 0, helperStatus: 0, installHelper: 0, getPlatform: 0 };
  (window as any).claude = {
    ...(opts.electron === false ? {} : { window: {} }),
    getPlatform: async () => { calls.getPlatform++; return platform; },
    buddy: {
      show: async () => { calls.show++; },
      hide: async () => {},
      helperStatus: async () => { calls.helperStatus++; return { supported: true, installed: false }; },
      installHelper: async () => { calls.installHelper++; return { ok: true }; },
    },
  };
  return calls;
}

const ENABLED = 'youcoded-buddy-enabled';
const MARKER = 'youcoded-buddy-linux-hidden-once';

/** Loads App.tsx fresh at a given URL. `buddyMode` is read from the query string
 *  at module scope, so a buddy-window test has to re-import. */
async function loadApp(search = '') {
  window.history.replaceState({}, '', search ? `/?${search}` : '/');
  vi.resetModules();
  return import('../src/renderer/App');
}

beforeEach(() => {
  localStorage.clear();
  delete (window as any).claude;
});

describe('R12 — the one-time Linux buddy hide', () => {
  it('switches an already-on buddy off, once, on Linux', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('hid');
    expect(localStorage.getItem(ENABLED)).toBe('0');
    expect(localStorage.getItem(MARKER)).toBe('1');
  });

  it('never fires a second time — the buddy the user turns back on stays on', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');
    await runBuddyLinuxHideMigration();

    // The user goes to Settings and switches the buddy back on.
    localStorage.setItem(ENABLED, '1');

    // Two more launches.
    expect(await runBuddyLinuxHideMigration()).toBe('already-run');
    expect(await runBuddyLinuxHideMigration()).toBe('already-run');
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });

  it('marks itself done even when the buddy was already off', async () => {
    // Otherwise a user whose buddy was off today, and who switches it on next
    // week, would have it switched off again at the following launch.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux');

    expect(await runBuddyLinuxHideMigration()).toBe('nothing-to-hide');
    expect(localStorage.getItem(MARKER)).toBe('1');

    localStorage.setItem(ENABLED, '1');
    expect(await runBuddyLinuxHideMigration()).toBe('already-run');
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });

  it('leaves Windows and macOS buddies alone', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    for (const platform of ['win32', 'darwin']) {
      localStorage.clear();
      installFakeClaude(platform);
      localStorage.setItem(ENABLED, '1');

      expect(await runBuddyLinuxHideMigration()).toBe('skipped');
      expect(localStorage.getItem(ENABLED)).toBe('1');
      expect(localStorage.getItem(MARKER)).toBe(null);
    }
  });

  it('does not run inside the buddy\'s own windows', async () => {
    // The mascot, chat and bar are separate windows running this same module
    // against the same profile's localStorage. Without the guard the migration
    // would fire up to three extra times per launch — including after the main
    // window had already let the user switch the buddy back on.
    for (const mode of ['buddy-mascot', 'buddy-chat', 'buddy-bar', 'buddy-overlay']) {
      const { runBuddyLinuxHideMigration } = await loadApp(`mode=${mode}`);
      localStorage.clear();
      installFakeClaude('linux');
      localStorage.setItem(ENABLED, '1');

      expect(await runBuddyLinuxHideMigration()).toBe('skipped');
      expect(localStorage.getItem(ENABLED)).toBe('1');
      expect(localStorage.getItem(MARKER)).toBe(null);
    }
  });

  it('does not run on a remote browser or on Android', async () => {
    // Those clients have no buddy at all, and remote-shim's buddy methods throw
    // rather than no-op. The probe is window.claude.window, the Electron-only
    // window-controls surface the shim deliberately omits.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux', { electron: false });
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('skipped');
    expect(localStorage.getItem(ENABLED)).toBe('1');
    expect(localStorage.getItem(MARKER)).toBe(null);
  });

  it('changes nothing when the platform cannot be read', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    (window as any).claude = {
      window: {},
      getPlatform: async () => { throw new Error('bridge not ready'); },
      buddy: {},
    };
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('skipped');
    expect(localStorage.getItem(ENABLED)).toBe('1');
    expect(localStorage.getItem(MARKER)).toBe(null);
  });
});

describe('R12 — the migration runs BEFORE the launch path reads the preference', () => {
  it('a previously-on Linux buddy is not re-opened at launch', async () => {
    // This is the whole point of the ordering: if the boot path read
    // youcoded-buddy-enabled first, it would call show() and put the stuck buddy
    // back on screen, and only THEN hide it for next time.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(calls.show).toBe(0);
    expect(localStorage.getItem(ENABLED)).toBe('0');
  });

  it('still re-opens the buddy at launch on every other platform', async () => {
    // Guard against "fixing" R12 by breaking the feature it sits in front of.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('darwin');
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(calls.show).toBe(1);
  });

  it('re-opens a Linux buddy the user has switched back on', async () => {
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');
    await bootBuddyOnLaunch();            // the update launch: hidden
    localStorage.setItem(ENABLED, '1');   // the user switches it back on

    await bootBuddyOnLaunch();            // the next launch

    expect(calls.show).toBe(1);
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });
});

describe('R13 — no dialog interrupts you after an update', () => {
  it('the launch path only stores a preference; it never asks anything', async () => {
    // The helper offer lives in Settings → Buddy Floater and is reached by
    // switching the buddy on. Launch must not reach for it: no helper status
    // call, no install, no window shown.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(calls.helperStatus).toBe(0);
    expect(calls.installHelper).toBe(0);
    expect(calls.show).toBe(0);
    // The only thing that changed is the stored preference.
    expect(localStorage.getItem(ENABLED)).toBe('0');
  });
});
