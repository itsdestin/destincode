// One provider-aware send for chat-view surfaces (InputBar, error-banner retry).
//
// Native sessions have NO PTY. They send a plain string over `native:send`
// (fire-and-forget) and the reply streams back as transcript events — so NONE
// of the Claude/PTY paste machinery (56-byte chunking, echo waits, trailing
// `\r`, Ink paste-timing) applies or may run for them.
//
// Dedup invariant: the native `user-message` transcript event carries the exact
// string HarnessSession was sent, and the reducer confirms the optimistic
// USER_PROMPT bubble by EXACT content match against `outgoing.content`. So the
// string built here MUST equal `buildOutgoingMessage(raw, paths).content` —
// which joins `[...filePaths, sanitized]`. Passing `outgoing.ptyText`
// (=sanitized) with the same filePaths reproduces that join exactly.

export function sendChatMessage(
  provider: 'claude' | 'native' | undefined,
  sessionId: string,
  ptyText: string,
  filePaths: string[] = [],
): void {
  if (provider === 'native') {
    const text = [...filePaths, ptyText].filter(Boolean).join(' ');
    window.claude.native.send(sessionId, text);
    return;
  }
  // Claude/PTY path — for file-bearing sends InputBar keeps its own
  // FILE_GAP_MS scheduling + echo-driven `\r` submit; this helper only owns the
  // native branch. For a plain (no-file) claude send this convenience appends
  // the submit `\r` the same way the PTY worker expects.
  window.claude.session.sendInput(sessionId, ptyText + '\r');
}
