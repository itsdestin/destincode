// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Per-project description (2026-08-05 design). Two channels because a project
  // has two metadata homes: a SYNCED project's description belongs in the
  // cross-device project registry (alongside displayName), a plain local
  // folder's in the saved-folders record (alongside nickname).
  { channel: 'syncSpaces.setProjectDescription', feature: 'per-project description' },
  { channel: 'folders.setDescription', feature: 'per-project description' },
];
