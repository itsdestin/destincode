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
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Games arcade Step 1 (docs/active/specs/2026-08-30-games-arcade-design.md).
  // The picker's deciding fact and the solo leaderboard are being designed
  // BEFORE the Worker endpoints that will serve them (§6.1) — which is exactly
  // what this registry is for. When the D1 table and its routes land, these two
  // rows come off and the fakes in mock-shim.ts stay so the workbench can still
  // show the you-alone and stale states without a live board.
  { channel: 'arcade.status', feature: 'Games arcade — per-game deciding fact in the picker (§4.1)' },
  { channel: 'arcade.leaderboard', feature: 'Games arcade — solo friend leaderboard (§6.1)' },
  // The Worker side of this one EXISTS (wecoded-marketplace, feat/games-arcade-scores)
  // — what is missing is the renderer→main→Worker path. Registered so the
  // dangling `arcade.submitScore?.()` call in ArcadeShell shows up on this
  // to-do list instead of silently doing nothing forever.
  { channel: 'arcade.submitScore', feature: 'Games arcade — publish a finished run to the board (§6.1)' },
];
