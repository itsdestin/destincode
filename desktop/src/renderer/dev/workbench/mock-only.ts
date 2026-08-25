// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Session references (spec 2026-08-10): designed in the workbench first.
  // These come OFF the list in Phase B when the real IPC lands — the contract
  // test fails if they stay here after preload.ts gains the channel.
  { channel: 'chatsearch.resolve', feature: 'chatsearch session references — Preview/Resume cards' },
  { channel: 'chatsearch.read', feature: 'chatsearch session references — transcript preview pane' },
];
