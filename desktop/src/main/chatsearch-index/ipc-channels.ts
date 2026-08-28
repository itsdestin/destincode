// The two channels the session-reference cards ride on.
//
// Keep every value in sync with preload.ts, remote-shim.ts, ipc-handlers.ts,
// remote-server.ts and SessionService.kt (stub) — ipc-channels.test.ts pins all
// five. No apostrophes in comments here: the parity test scans this file for
// single-quoted strings.
export const CHATSEARCH_IPC = {
  RESOLVE: 'chatsearch:resolve',
  READ: 'chatsearch:read',
} as const;
