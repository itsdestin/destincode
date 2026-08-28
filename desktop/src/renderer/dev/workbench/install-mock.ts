// Dev-only. Installs a fake window.claude so the real renderer can boot with no
// Electron main process, no PTY and no remote server. See
// docs/active/specs/2026-07-29-ui-workbench-design.md.

import { createStore } from './mock-store';
import { createMockShim } from './mock-shim';
import { SCENARIO_IDS, type ScenarioId } from './scenarios';
// Task 7c: swaps the real PartyKit socket for an in-page fake so Connect Four
// is playable (and filmable) with no network. See fake-party.ts for the WHY.
import { FakePartySocket, isWorkbenchAutoplay } from './fake-party';
import { __setPartySocketFactory } from '../../game/party-client';

/** Scenario comes from ?scenario= so a reload lands on the same seed. An
 *  unrecognised value falls back to 'default' rather than throwing — a typo in
 *  the URL should not blank the app being reviewed. */
function currentScenario(): ScenarioId {
  if (typeof location === 'undefined') return 'default';
  const raw = new URLSearchParams(location.search).get('scenario');
  return (SCENARIO_IDS as readonly string[]).includes(raw ?? '')
    ? (raw as ScenarioId)
    : 'default';
}

/** Assigns the mock bridge. No-op when a real bridge is already present —
 *  this is what stops the workbench from ever shadowing Electron's preload
 *  or a connected remote shim. */
/** The workbench renders the DESKTOP app, so it must say so.
 *
 *  platform-bootstrap.ts decides the platform from `window.claude` at
 *  module-graph head and mirrors it onto `<html data-platform>` synchronously,
 *  "so it lands before any style evaluates". The workbench installs its mock in
 *  index.tsx's boot branch — after every import has evaluated — so that check
 *  sees no bridge, leaves `__PLATFORM__` unset, and never writes the attribute.
 *
 *  The consequence is not subtle: EVERY `html[data-platform="electron"]` rule
 *  in globals.css silently does nothing. That includes both halves of the
 *  terminal bottom-frame fix (PR #196), so terminal view rendered without its
 *  bottom frame strip and looked exactly like a bug that had already been fixed
 *  in the app. A workbench that mis-renders real CSS is worse than no
 *  workbench — it sends you hunting for bugs that are not there.
 *
 *  Setting it here is enough for CSS because the attribute is only read by
 *  selectors, and this runs before `createRoot().render()`. Module-level consts
 *  that captured `isAndroid()` at import time already fall back to 'electron'
 *  (platform.ts), which is the answer we want anyway. */
function declarePlatform(): void {
  const w = window as any;
  // `?platform=android` films the phone half of the landing page's sync row —
  // the header drops its window buttons and the shell lays out as the phone does.
  // Caveat: this runs AFTER the module graph loaded, so CSS and render-time
  // `isAndroid()` checks are right, but import-time consts (HeaderBar's
  // toggleOnLeft) still see 'electron' — film the phone NARROW (390 wide), where
  // the narrow layout hides that toggle anyway.
  // `typeof location` guard: workbench-install-mock.test.ts runs this in Node.
  if (!w.__PLATFORM__ && typeof location !== 'undefined' && new URLSearchParams(location.search).get('platform') === 'android') w.__PLATFORM__ = 'android';
  if (!w.__PLATFORM__) w.__PLATFORM__ = 'electron';
  if (typeof document !== 'undefined' && !document.documentElement.dataset.platform) {
    document.documentElement.dataset.platform = w.__PLATFORM__;
  }
}

export function installMock(): void {
  if ((window as any).claude) return;
  declarePlatform();
  const store = createStore(currentScenario());
  // Read by the toolbar (Task 7) so it can reseed and inspect without the
  // app's provider tree having to thread the store through.
  (window as any).__workbenchStore = store;
  (window as any).claude = createMockShim(store);
  // Only when filming with `?signedIn=1` (Task 7c) — a signed-out workbench
  // never touches party-client.ts, so `__setPartySocketFactory` stays unset
  // and the (unreachable, since the game panel needs an account) real
  // PartySocket path is exactly what it was before this file existed.
  if (isWorkbenchAutoplay()) {
    __setPartySocketFactory(FakePartySocket);
  }
}
