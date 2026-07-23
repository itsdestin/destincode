// Provider-aware chat send. Today its ONLY live caller is InputBar's native
// branch (the native path below). The claude branch and a future error-banner
// "Try again" caller (Task 11 TODO in ChatView) are reserved — both are tested
// but not yet wired at a second call site; keep them so the helper stays the
// single provider-aware send point when those land.
//
// Native sessions have NO PTY. They send a plain string over `native:send`
// (which acks sent/queued/failed — see the M1 note below) and the model's
// reply streams back separately as transcript events — so NONE of the
// Claude/PTY paste machinery (56-byte chunking, echo waits, trailing `\r`,
// Ink paste-timing) applies or may run for them.
//
// Dedup invariant: the native `user-message` transcript event carries the exact
// string HarnessSession was sent, and the reducer confirms the optimistic
// USER_PROMPT bubble by EXACT content match against `outgoing.content`. So the
// string built here MUST equal `buildOutgoingMessage(raw, paths).content` —
// which joins `[...filePaths, sanitized]`. Passing `outgoing.ptyText`
// (=sanitized) with the same filePaths reproduces that join exactly.
//
// M1 (bubble-after-ack): the native branch now returns the ack Promise
// instead of firing-and-forgetting. InputBar awaits it and ONLY THEN
// dispatches USER_PROMPT (queued: result.status === 'queued') so a refused
// send ('failed') shows a toast instead of a phantom bubble. The CC/PTY path
// stays void -- InputBar dispatches USER_PROMPT before calling this at all
// for that provider.

import type { NativeSendResult } from '../../shared/types';

// Overloads let a call site passing the literal 'native' provider get back a
// plain `Promise<NativeSendResult>` (no stray `| void`) without a cast at the
// call site — InputBar's native branch awaits the result directly.
export function sendChatMessage(
  provider: 'native',
  sessionId: string,
  ptyText: string,
  filePaths?: string[],
): Promise<NativeSendResult>;
export function sendChatMessage(
  provider: 'claude' | undefined,
  sessionId: string,
  ptyText: string,
  filePaths?: string[],
): void;
export function sendChatMessage(
  provider: 'claude' | 'native' | undefined,
  sessionId: string,
  ptyText: string,
  filePaths: string[] = [],
): Promise<NativeSendResult> | void {
  if (provider === 'native') {
    const text = [...filePaths, ptyText].filter(Boolean).join(' ');
    return window.claude.native.send(sessionId, text);
  }
  // Claude/PTY path — for file-bearing sends InputBar keeps its own
  // FILE_GAP_MS scheduling + echo-driven `\r` submit; this helper only owns the
  // native branch. For a plain (no-file) claude send this convenience appends
  // the submit `\r` the same way the PTY worker expects.
  window.claude.session.sendInput(sessionId, ptyText + '\r');
}
