// Dev-only. Installs a fake window.claude so the real renderer can boot with no
// Electron main process, no PTY and no remote server. See
// docs/active/specs/2026-07-29-ui-workbench-design.md.

import { createStore } from './mock-store';
import { createMockShim } from './mock-shim';
import { SCENARIO_IDS, type ScenarioId } from './scenarios';

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
export function installMock(): void {
  if ((window as any).claude) return;
  const store = createStore(currentScenario());
  // Read by the toolbar (Task 7) so it can reseed and inspect without the
  // app's provider tree having to thread the store through.
  (window as any).__workbenchStore = store;
  (window as any).claude = createMockShim(store);
}
