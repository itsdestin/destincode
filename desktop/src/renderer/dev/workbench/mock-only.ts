// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Native specialists plan 1c — chat UI + definitions folder + tier pickers.
  // Task 8 shipped the real backend for six of these seven (list, the tier
  // get/set pair, steer/interrupt, and the specialists:event push) — see
  // ipc-handlers.ts/preload.ts/remote-shim.ts's `specialists:*` surfaces —
  // so their rows came off here, same as the `permissions.*` trio did below.
  // openFolder is the one still unbuilt: a generic "reveal this folder"
  // control, not part of Task 8's five request channels.
  { channel: 'specialists.openFolder', feature: 'native specialists 1c (definitions folder)' },
  // (History: the `permissions.*` trio lived here while the management UI
  // (M5 2a) was designed against fake data; they came off when the real
  // store/host/IPC landed. The mock namespace in mock-shim.ts STAYS after a
  // backend ships — the workbench still needs fixture data — only the "no real
  // backend" claim goes.)
];
