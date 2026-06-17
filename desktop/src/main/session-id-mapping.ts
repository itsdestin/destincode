// Decision logic for the desktop→Claude session id map in ipc-handlers.ts.
//
// WHY this exists: the map used to be set-once per desktop session, but
// Claude Code rotates its session id mid-PTY on `/clear` (verified: `--resume`
// does NOT rotate — it appends the same file). With a stale mapping, close-time
// flags and topic lookups landed on the pre-/clear session id. Only
// SessionStart is trusted for a REMAP because subagent/tool hook events can
// carry child session ids — adopting those would point flags and topic
// watchers at a subagent transcript.

export type MappingAction = 'adopt' | 'ignore';

export function resolveMappingAction(
  currentClaudeId: string | undefined,
  incomingClaudeId: string,
  hookEventName: string | undefined,
): MappingAction {
  if (!currentClaudeId) return 'adopt';                      // first sighting
  if (currentClaudeId === incomingClaudeId) return 'ignore'; // no change
  return hookEventName === 'SessionStart' ? 'adopt' : 'ignore';
}
