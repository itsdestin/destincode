// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
// Empty: Task 8 shipped the real backend for the six specialists channels
// (list, the tier get/set pair, steer/interrupt, and the specialists:event
// push) — see ipc-handlers.ts/preload.ts/remote-shim.ts's `specialists:*`
// surfaces. The seventh row this list used to carry, `specialists.openFolder`,
// turned out not to need its own channel at all: Task 10's "Open folder"
// button calls the existing generic `shell.openPath`, so there is no bespoke
// channel left to build. (The mock namespace in mock-shim.ts STAYS — the
// workbench still needs fixture data — only the "no real backend" claim goes.)
//
// chatsearch.resolve / chatsearch.read were listed here too while the session
// reference cards were designed ahead of their backend, and came off when the
// real IPC landed. Same rule, same reason: their fake namespace stays so the
// tool gallery can show every row state without a real index.
//
// G-1 background Bash's `native.killShell` was listed here while the card was
// designed ahead of its backend, and came off when `native:kill-shell` landed
// on all five surfaces (2026-08-28). Same rule, same reason as the rows above:
// the fake in mock-shim.ts stays so the tool gallery can show every card state
// without a real process — only the "no real backend" claim goes.
// The three games-arcade rows (`arcade.status`, `arcade.leaderboard`,
// `arcade.submitScore`) came off when their real backend landed: the Worker's
// /games/scores routes, main/arcade-handlers.ts, and all five surfaces. Exactly
// the lifecycle this registry is for — the UI was designed and reviewed against
// a fake, the fake told us what to build, and the fakes in mock-shim.ts stay so
// the workbench can still show the you-alone, empty and stale-board states
// without a live leaderboard. `no MOCK_ONLY entry has since gained a real
// channel` in workbench-mock-contract.test.ts is what forces this cleanup.
//
// `engine.prereqs` came off this list on 2026-09-05 when the real check landed
// (main/engine/rocm-prereqs.ts on all five surfaces). Its fake in mock-shim.ts
// stays, so the workbench can still walk the "missing, then present" flow
// without a machine that is actually missing the libraries.
//
// 2026-09-05 — local-engine upgrades (docs/active/design/2026-09-04-local-engine-upgrades):
// six channels were designed in the workbench ahead of main, and all six have now landed on
// every surface (ipc-handlers + preload + remote-shim + remote-server + SessionService.kt):
//   engine.prereqs, engine.runInTerminal, engine.setConfig (which replaced engine.setSpeed),
//   models.settings, models.setSettings, models.addVision.
// `models.dismissMemoryWarning` never got a channel of its own: it folded into
// models.setSettings, so one write covers everything a model's settings own. Every fake in
// mock-shim.ts stays — the workbench still has no machine, no PTY and no engine — only the
// "no real backend" claim goes.
//
// The list is EMPTY, and that is the healthy state: it means nothing on screen in the
// workbench is pretending to be a feature that does not exist yet. Add a row the moment you
// design a channel ahead of its backend; delete the row, never the guard, when it ships.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [];
