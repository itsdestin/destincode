// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Empty today. The `permissions.*` trio lived here while the management UI
  // (M5 2a) was designed against fake data; they came off when the real
  // store/host/IPC landed. The mock namespace in mock-shim.ts STAYS — the
  // workbench still needs fixture data — only the "no real backend" claim goes.
  //
  // Add entries as new UI is designed ahead of its backend, e.g.
  //   { channel: 'thing.list', feature: 'thing manager (M9)' },
];
