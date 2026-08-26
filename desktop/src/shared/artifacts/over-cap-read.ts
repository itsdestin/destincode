import { looksBinary, EDIT_MAX_BYTES } from './editable-path-policy';

/** How much of the window the newline rule must retain to be worth using. */
const NEWLINE_KEEP_RATIO = 0.5;

/**
 * Cut a byte buffer down to at most `maxBytes` of text for the partial view.
 *
 *  1. Prefer the last newline -- a line shown cut in half looks like corruption.
 *  2. Unless that newline is so early it would throw away most of what we read
 *     (a short header line followed by one enormous minified line), or there is
 *     no newline at all. Then cut at the last complete UTF-8 character instead,
 *     so a multi-byte character is not split. The result is one very long line --
 *     which is what the file actually is.
 *
 * Honest limitation: a file that is not valid UTF-8 (Latin-1 with accents, say)
 * has no NUL bytes, so it passes the binary sniff and decodes with replacement
 * characters. That is true of the existing under-cap read too; this function
 * does not make it worse and does not claim to fix it.
 */
export function textPrefix(buf: Uint8Array, maxBytes: number): string {
  const win = buf.subarray(0, Math.min(buf.length, maxBytes));
  if (win.length === 0) return '';
  const dec = new TextDecoder('utf-8');
  const nl = win.lastIndexOf(0x0a);
  if (nl >= 0 && nl + 1 >= win.length * NEWLINE_KEEP_RATIO) {
    return dec.decode(win.subarray(0, nl + 1));
  }
  // Walk back to the START of the last character, then keep it only if all of
  // its bytes are present. (0b10xxxxxx is a UTF-8 continuation byte.)
  let start = win.length - 1;
  while (start > 0 && (win[start] & 0xc0) === 0x80) start--;
  const lead = win[start];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const end = start + need <= win.length ? win.length : start;
  return dec.decode(win.subarray(0, end));
}

/**
 * The decision `artifacts:get` makes above EDIT_MAX_BYTES (spec §4.2). Pure so
 * it can be tested without Electron -- and called by the handler, so the test
 * exercises the shipped branch rather than a copy of it.
 *
 * `head` is the first 8 KB; `window` is up to EDIT_MAX_BYTES of the file. The
 * caller reads both before asking, because the answer to "is this text?" decides
 * which of two completely different responses the renderer gets.
 */
export function decideOverCapRead(head: Uint8Array, window: Uint8Array):
  { content: string | null; binary: boolean; truncated: boolean } {
  // Sniff the HEAD before deciding what to say. The old code refused without
  // knowing what the file was, so an over-cap IMAGE got the text editor's error.
  if (looksBinary(head)) return { content: null, binary: true, truncated: false };
  return { content: textPrefix(window, EDIT_MAX_BYTES), binary: false, truncated: true };
}
