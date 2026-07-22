// Cross-component channel for the D3 unsaved-changes guard. The dialog and
// dirty state live inside the artifact host (SessionDrawer / ProjectView
// overlay), but several DISCARD paths are triggered from outside it:
// the HeaderBar/OverflowMenu drawer toggle, and session switching (which
// remounts the drawer wholesale). Those callers cannot reach the host's
// guard directly, so the host registers it here while mounted and outside
// actors route through guardDirtyEditor().
//
// Singleton by design: one window shows one artifact host with edit state at
// a time (the drawer belongs to the active session; the ProjectView overlay
// covers it). Last registrant wins; unregister restores the fall-through.
type Guard = (action: () => void) => void;

let current: Guard | null = null;

export function registerDirtyEditorGuard(guard: Guard): void {
  current = guard;
}

export function unregisterDirtyEditorGuard(guard: Guard): void {
  if (current === guard) current = null;
}

/** Run `action` now, or behind the registered host's Save/Discard/Cancel
 * dialog when that host currently holds a dirty editor. */
export function guardDirtyEditor(action: () => void): void {
  if (current) current(action);
  else action();
}
