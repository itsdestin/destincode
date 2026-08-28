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
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [];
