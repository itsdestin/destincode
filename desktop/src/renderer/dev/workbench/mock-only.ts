// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  { channel: 'permissions.list', feature: 'permissions management UI (M5 2a)' },
  { channel: 'permissions.remove', feature: 'permissions management UI (M5 2a)' },
  { channel: 'permissions.removeProject', feature: 'permissions management UI (M5 2a)' },
];
