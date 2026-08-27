// fs:read-head — the ONE channel that hands the renderer the first bytes of an
// arbitrary file, so a tile can preview it (the composer's attachment cards:
// rendered markdown, a mono block for text/code). Shared constants + result
// shape live here so main (ipc-handlers / remote-server), the renderer hook,
// the workbench mock and the tests agree; SessionService.kt mirrors the
// numbers by hand (Android has no import path into this file).
//
// SECURITY: this IPC RETURNS file contents and, on remote-access setups, is
// reachable over the WebSocket from a remote browser. It is deliberately tiny:
// the main-process handler clamps every request to READ_HEAD_MAX_BYTES no
// matter what the caller asks for, refuses well-known secret locations
// (isSensitivePath — .ssh, .netrc, dotenv, credential stores) and relative
// paths, and never reads past the cap. It is NOT roots-gated like
// artifacts:read-binary, because the composer attaches whatever the user picks
// in the OS file dialog (~/Documents/notes.md is the normal case) — the preview
// has to work on exactly those files.

/** Hard cap on bytes a single head read may return, whatever was requested. */
export const READ_HEAD_MAX_BYTES = 4096;
/** What a preview tile asks for — enough for a heading, a paragraph, a list. */
export const READ_HEAD_DEFAULT_BYTES = 600;

export type ReadHeadResult =
  | { ok: true; text: string; truncated: boolean }
  // 'no path' (missing/relative), 'not-allowed' (sensitive), 'orphan'
  // (ENOENT), 'not-a-file' (directory), 'binary' (NUL in the head), or the
  // real fs error message — never a guessed cause.
  | { ok: false; error: string };

/** Clamp a caller's byte request into [1, READ_HEAD_MAX_BYTES]; non-numbers
 *  get the default. */
export function clampHeadBytes(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.floor(requested)
    : READ_HEAD_DEFAULT_BYTES;
  return Math.min(READ_HEAD_MAX_BYTES, Math.max(1, n));
}

/** UTF-8 decode a head slice. A cut in the middle of a multi-byte character
 *  decodes to U+FFFD at the very end; when the read was truncated that
 *  trailing replacement char is the cut, not the file, so it is dropped. */
export function decodeHead(bytes: Uint8Array, truncated: boolean): string {
  let text = new TextDecoder('utf-8').decode(bytes);
  if (truncated) text = text.replace(/�$/, '');
  return text;
}
