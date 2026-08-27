// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Empty on purpose. chatsearch.resolve / chatsearch.read lived here while the
  // cards were designed ahead of their backend, and came off when the real IPC
  // landed (Task 11) — the contract test fails if a channel stays listed after
  // preload.ts gains it. The workbench's fake chatsearch namespace STAYS: it is
  // what lets the tool gallery show every row state without a real index.
];
