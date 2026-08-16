// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Native specialists plan 1c — chat UI + definitions folder + tier pickers.
  // The backend to-do this list IS: a `specialists:list` roster channel (built-
  // ins + personal + project + CC-mapped, with warnings), the delegated-model
  // tier get/set pair over DelegatedModels (1b shipped storage only), steer/
  // interrupt over NativeSessionHost.steerSpecialist/interruptSpecialist, and
  // a `specialists:event` push fed by the delegation ledger.
  { channel: 'specialists.list', feature: 'native specialists 1c (roster)' },
  { channel: 'specialists.getDelegatedModels', feature: 'native specialists 1c (tier pickers)' },
  { channel: 'specialists.setDelegatedModel', feature: 'native specialists 1c (tier pickers)' },
  { channel: 'specialists.steer', feature: 'native specialists 1c (card actions)' },
  { channel: 'specialists.interrupt', feature: 'native specialists 1c (card actions)' },
  { channel: 'specialists.openFolder', feature: 'native specialists 1c (definitions folder)' },
  { channel: 'on.specialistEvent', feature: 'native specialists 1c (delegation feed)' },
  // (History: the `permissions.*` trio lived here while the management UI
  // (M5 2a) was designed against fake data; they came off when the real
  // store/host/IPC landed. The mock namespace in mock-shim.ts STAYS after a
  // backend ships — the workbench still needs fixture data — only the "no real
  // backend" claim goes.)
];
