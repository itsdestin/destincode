// WebFetch (spec §3.1): guardedFetch → Readability extraction → Markdown →
// shared truncation. CC-compatible input shape {url, prompt?} so the existing
// WebFetchView renders unchanged (it markdown-renders the result string).
// DESIGN (plan decision 9): no secondary summarization model — the result IS
// the extracted markdown; `prompt` is echoed as a context header.
// DOM provider is linkedom (NOT domino/jsdom) — Task 1 verified readability
// 0.6.0 breaks on domino's non-iterable NodeLists.
import { z } from 'zod';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
// turndown ships no bundled types and @types/turndown isn't a dependency in this
// repo — suppress the implicit-any import here rather than add a shared
// devDependency or a new .d.ts file (plan: type accommodations stay in MY files
// only). linkedom and @mozilla/readability both ship their own types.
// Tried @ts-expect-error (the self-cleaning choice) first, but under THIS repo's
// tsconfig tsc does NOT error on the turndown import — turndown resolves to a .js
// with no adjacent .d.ts and skipLibCheck is on — so @ts-expect-error itself trips
// TS2578 "unused directive" and breaks the build. Reverted to @ts-ignore per that
// empirical outcome; it stays a defensive suppressor if the resolution ever changes.
// @ts-ignore -- no type declarations for 'turndown'
import TurndownService from 'turndown';
import { defineTool } from './registry';
import { guardedFetch, readBodyCapped, NetGuardError, type GuardedFetchOpts } from './net-guard';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

// Test seam: unit tests inject lookup/fetch; production uses the real ones.
let testHooks: Pick<GuardedFetchOpts, 'lookup' | 'fetchImpl'> = {};
export function __setWebFetchTestHooks(h: typeof testHooks): void { testHooks = h; }

const inputSchema = z.object({
  url: z.string().describe('The URL to fetch (http/https only)'),
  prompt: z.string().optional().describe('What you want to learn from this page'),
});

const TEXT_TYPES = /^(text\/(plain|markdown|csv|xml)|application\/(json|xml|rss\+xml|atom\+xml))/;

// --- Pre-parse complexity guard (CRITICAL: main-thread DoS defense) ----------
// htmlToMarkdown() runs parseHTML → Readability.parse() → turndown ALL
// SYNCHRONOUSLY on the Electron MAIN event loop (NativeSessionHost executes tools
// on the main loop — there is no worker offload). Readability.parse() is roughly
// QUADRATIC in DOM nesting depth, so a small but pathological page freezes EVERY
// window, all IPC, and the live session for tens of seconds. Measured on this
// machine: 150-deep divs ~0.4s, 200-deep ~1.1s, 400-deep ~4.1s, 1000-deep ~53s;
// ~15k tags ~0.6s, ~120k tags ~5s. The 5MB byte cap does NOT bound this — parse
// cost scales with DOM STRUCTURE (depth/tag-count), not byte length (a 54KB file
// can hang for seconds). And defineTool's try/catch CANNOT save us: a synchronous
// hang never throws, so nothing unwinds. This O(n)-on-the-raw-string pre-check is
// therefore the ONLY guard — it must reject pathological input BEFORE it reaches
// Readability. Thresholds sit far above real articles (which nest ~8-60 and carry
// a few thousand tags).
//
// CORRECTION (Minor finding, round 4, 2026-08-06 review): this comment used to
// claim a page that PASSES the guard stays "under ~0.6s of parse time" — false,
// and not a promise this guard can make. Measured: a page of 145-deep nesting x
// 50 sibling blocks (14,504 '<', max depth 147 — comfortably clearing both
// MAX_DEPTH and MAX_TAGS) took 1,617ms through execute() in the review that
// found this. That cost is Readability's scoring + turndown's conversion, NOT
// this round's new DOM fragment query (measured 1,617ms with a fragment query
// present vs 1,607ms without, on the same page — the query is noise next to
// Readability). Independently re-measured on the machine fixing this: the same
// construction (tag count and depth both matched exactly) completed in
// 220-275ms across 5 runs — still well under a second, but the point stands
// regardless of which number a given machine produces: this guard bounds
// Readability's WORST case (pathological structure), not its typical-case
// runtime, and clearing MAX_DEPTH/MAX_TAGS is not a bound on wall-clock time.
// Do not add a number back here that a reader could rely on as a promise.
const MAX_DEPTH = 150;
const MAX_TAGS = 15_000;

// Void elements never open a nesting level (no close tag), so they must not
// increment depth or every <br>/<img>-heavy page would over-count.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** ASCII letter/digit test for tag- and attribute-name characters. A plain
 *  charCode range check (not a per-character regex) so walkTags below stays
 *  cheap per character while still doing a single forward pass overall. */
function isNameChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57);
}

/** One tag found by walkTags: lowercased name, whether it's a closing tag,
 *  and whether it's self-closed (`<br/>`). Used only by the depth guard as of
 *  the 2026-08-06 round-3 redesign — anchor/id collection no longer scans
 *  raw HTML at all (see findAnchor below), so the raw attribute text this
 *  token used to carry is gone; nothing needs it anymore. */
interface TagToken { name: string; isClose: boolean; selfClosed: boolean; }

/** Case-insensitive indexOf for a short, fixed, ASCII-only needle (the
 *  script/style closing tags below), WITHOUT allocating a lowercased copy of
 *  the whole haystack.
 *
 *  WHY this exists (CRITICAL, 2026-08-06 round-3 review): walkTags used to
 *  build one `lower = html.toLowerCase()` up front and index it with cursors
 *  computed against `html`'s own length. That is only safe if lowercasing
 *  never changes a string's length, which is false for some codepoints —
 *  `'İ'.toLowerCase()` (U+0130) is TWO UTF-16 units ('i' + a combining dot).
 *  Payload: a comment body of 200,000 'İ' characters. `lower.length` ends up
 *  200,000 code units longer than `html.length`, so the comment-close search
 *  — done against `lower` — finds `-->` at an index that overshoots the SAME
 *  position in `html` by 200,000 characters, and `i = lower.indexOf(...) + 3`
 *  fed that overshot index straight back into the `html` cursor. A 1,000-deep
 *  `<div>` nest placed right after the comment was skipped over entirely, so
 *  the guard measured depth < 150 (safe), Readability ran on a document that
 *  was ACTUALLY 1,000 deep, and WebFetchTool.execute blocked the main loop
 *  for 8,376ms. Measured at the commit before this fix (e1eee255^): the same
 *  payload was rejected by the guard in 3ms with Readability never called —
 *  see "does not freeze on comment bodies containing surrogate-expanding
 *  lowercase folds" in web-fetch-tool.test.ts for the pinned numbers.
 *
 *  The fix removes the aliasing at the root: there is only ever ONE string
 *  (`html`) and one index space. Where a case-insensitive comparison is
 *  still needed (script/style tag names, their closing tags), it is done
 *  either by folding a small BOUNDED slice (a tag name, a handful of
 *  characters — see the `name` assignment below, whose result is used only
 *  for value comparisons, never as a source of offsets into `html`) or, for
 *  the closer search below, by folding one ASCII character at a time as the
 *  comparison runs, so no second string of a different length is ever built.
 *
 *  CORRECTION (round 4, 2026-08-06 review): the paragraph above describes
 *  walkTags, which this function was written for and which never had a
 *  second bug. But stripToText and withoutScriptAndStyle further down this
 *  file each still built their OWN `lower = html.toLowerCase()` and indexed
 *  it with `html`-cursor offsets — the identical aliasing bug, independently
 *  introduced, just not yet caught. "There is only ever ONE string" was true
 *  of walkTags but false of the file as a whole until this round: a
 *  100-character 'İ' prefix ahead of a `<script>` tag made the guard-path
 *  fallback silently drop real visible text (and leak the script's own
 *  source) in one measured case, and separately let 60 leading 'İ'
 *  characters turn off the JS-rendered-page disclosure on an otherwise
 *  ordinary Next.js-shaped shell. Both are now fixed using this exact same
 *  technique (see foldStartsWith below), so the claim is file-wide and
 *  accurate again — see stripToText's and withoutScriptAndStyle's own WHY
 *  comments for the specific measurements. */
function indexOfFold(haystack: string, needle: string, from: number): number {
  const hn = haystack.length, nn = needle.length;
  outer: for (let i = from; i + nn <= hn; i++) {
    for (let j = 0; j < nn; j++) {
      const a = haystack.charCodeAt(i + j);
      const b = needle.charCodeAt(j); // needle is always already-lowercase ASCII
      if (a === b) continue;
      const folded = a >= 65 && a <= 90 ? a + 32 : a; // fold ASCII A-Z to a-z only
      if (folded !== b) continue outer;
    }
    return i;
  }
  return -1;
}

/** Case-insensitive startsWith for a short, fixed, ASCII needle at a known
 *  position, using the exact same bounded-fold technique as indexOfFold
 *  above (and for the same reason — see its WHY comment). Exists so
 *  stripToText and withoutScriptAndStyle below never need to build a
 *  document-length lowercased copy either; see their WHY comments. */
function foldStartsWith(haystack: string, needle: string, at: number): boolean {
  const nn = needle.length;
  if (at + nn > haystack.length) return false;
  for (let j = 0; j < nn; j++) {
    const a = haystack.charCodeAt(at + j);
    const b = needle.charCodeAt(j); // needle is always already-lowercase ASCII
    if (a === b) continue;
    const folded = a >= 65 && a <= 90 ? a + 32 : a;
    if (folded !== b) return false;
  }
  return true;
}

/** Finds where a raw-text element's content (a `<script>` or `<style>` body)
 *  actually ends, per the tokenizer THIS repo's HTML parser really runs —
 *  linkedom parses via `htmlparser2` (verified by reading
 *  node_modules/linkedom/esm/shared/parse-from-string.js, which imports
 *  `htmlparser2` directly). htmlparser2's `stateInSpecialTag` (Tokenizer.js)
 *  closes a script/style at the first case-insensitive `</script` or
 *  `</style` whose NEXT character is `>` or ASCII whitespace (space, tab,
 *  LF, FF, CR) — it does NOT require an exact `</script>` / `</style>`
 *  literal, and a near-match whose next char is anything else (`</scripts`)
 *  is rejected and scanning resumes.
 *
 *  WHY this exists (BLOCKER B2, round 5, 2026-08-06 review): the previous
 *  code searched for the literal string `</script>` (needing the `>` to
 *  immediately follow the name with no whitespace), so it disagreed with
 *  linkedom about where a script ends. Payload `<script>x</script >` (one
 *  space before `>`) is, to linkedom, an ordinary closed `<script>` followed
 *  by ordinary markup; to the old code, the literal `</script>` substring
 *  never occurs, so the script is treated as never closing and everything
 *  after it — 14,900 `<div>` opens in the reviewer's PoC — was swallowed
 *  into "still inside script, don't count it" and never reached
 *  MAX_TAGS/MAX_DEPTH. Measured on this machine (`WebFetchTool.execute`,
 *  `'<script>x</script >' + '<div>'.repeat(14900)`, 74,520 bytes): guard let
 *  the payload through and Readability then blocked the main thread for
 *  12,246ms (control, unwrapped divs: 2ms, rejected by the guard). See
 *  "rejects a </script > (whitespace-terminated) close bypass" in
 *  web-fetch-tool.test.ts for the pinned number.
 *
 *  Returns the index to resume scanning from (just past the recognized
 *  closing tag's own `>`), or -1 if the element never closes in the rest of
 *  the string — same failure contract as indexOfFold, so callers treat it
 *  identically to the old closeIdx check.
 *
 *  Linear by construction, same discipline as indexOfFold: each retry after
 *  a near-miss (`</scripts`) resumes searching strictly AFTER that miss's
 *  start position, never earlier — so across every retry combined, each
 *  character of `html` is examined by at most one of the scans, and total
 *  work stays O(remaining length) regardless of how many false `</script`
 *  prefixes an attacker plants. */
function findRawTextEnd(html: string, name: 'script' | 'style', from: number): number {
  const closer = '</' + name; // already-lowercase ASCII needle for indexOfFold
  const n = html.length;
  let i = from;
  for (;;) {
    const idx = indexOfFold(html, closer, i);
    if (idx === -1) return -1;
    const after = idx + closer.length;
    const c = after < n ? html.charCodeAt(after) : -1;
    // Terminator set matches htmlparser2's isEndOfTagSection minus '/' — its
    // stateInSpecialTag checks ONLY `c === Gt || isWhitespace(c)` for a
    // script/style closer specifically (unlike an ordinary tag's name, which
    // also ends on '/'), so '/' is deliberately excluded here too.
    if (c === 62 /* '>' */ || c === 32 || c === 9 || c === 10 || c === 12 || c === 13) {
      const gt = html.indexOf('>', after);
      return gt === -1 ? -1 : gt + 1;
    }
    // Not a real close (e.g. '</scripts') — resume strictly after this
    // candidate's start so it is never re-examined; see the WHY block above.
    i = idx + 1;
  }
}

/** Shared linear tag walker for the complexity guard's depth count (its only
 *  remaining caller as of round 3 — see TagToken above). Before this, the
 *  guard's depth scan ran its own regex over the raw string and was
 *  quadratic on adversarial input shaped like many unterminated '<a' tags —
 *  see the WHY comment on the tagCount/`maxDepth` check below for that
 *  history, and indexOfFold's WHY comment above for the CURRENT (round 3)
 *  defect this walker fixes.
 *
 *  This walker is linear BY CONSTRUCTION: `i` only moves forward. The
 *  load-bearing fix is the early `return` on a failed indexOf('>', ...): the
 *  FIRST time no '>' is found searching from position p to the end of the
 *  string, NO tag starting anywhere at or after p can ever close either (a
 *  match must consume a literal '>' that indexOf just proved does not exist
 *  in the remainder) — so stopping once, instead of retrying at every
 *  subsequent '<', is what makes total work O(n) regardless of content
 *  shape. See "does not freeze" tests in web-fetch-tool.test.ts for the
 *  pinned numbers.
 *
 *  Script/style bodies are skipped wholesale (not walked for nested tags),
 *  same as stripToText's first phase, because their text can contain tag- or
 *  attribute-shaped substrings that are not real DOM (`document.write('<div>')`,
 *  `var s = 'id=leaked'`). A real HTML parser — including linkedom, which this
 *  guard exists to protect Readability from — never parses script/style
 *  contents as elements either, so this keeps the guard's depth estimate
 *  tracking what Readability will actually see; it does not relax MAX_DEPTH
 *  or MAX_TAGS. */
function walkTags(html: string, onTag: (tag: TagToken) => void): void {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return;
    if (html.startsWith('<!--', lt)) {
      // '<!--' and '-->' are fixed, non-alphabetic delimiters — no case
      // folding applies, so this searches `html` directly with no second
      // string and no risk of the aliasing bug above.
      //
      // WHY the search starts at `lt + 2`, not `lt + 4` (BLOCKER B2, round 5,
      // 2026-08-06 review): htmlparser2's stateBeforeComment (the tokenizer
      // linkedom actually runs — see findRawTextEnd's WHY block above) treats
      // the comment's own opening `--` as if it were ALREADY the first two
      // characters of a potential closing `-->` — its comment reads "Allow
      // short comments (eg. <!-->)". So `<!-->` and `<!--->` close
      // immediately, with EMPTY content, using the opening dashes as the
      // closer's own dashes; the old `lt + 4` search started AFTER those
      // dashes and could never find a `-->` inside a bare `<!-->` (there
      // are only 5 bytes total — no room for a second, separate `-->`), so
      // the "comment" was treated as never closing and everything after it
      // was swallowed as "still inside a comment, don't count it." Searching
      // from `lt + 2` lets the match land ON the opening dashes for the
      // abrupt-close forms while still finding the same real `-->` as before
      // for every ordinary (non-abrupt) comment — verified: for a comment
      // with real content, no `-->` substring can occur 2 characters earlier
      // than the true closer without ALSO being the true closer's own
      // dashes, so this never fires early on ordinary input.
      //
      // Payload: '<!-->' + '<div>'.repeat(14900), 74,530 bytes. Measured on
      // this machine through WebFetchTool.execute: guard let it through and
      // Readability blocked the main thread for 13,656ms at the old `lt + 4`
      // offset (control, unwrapped divs: 2ms, rejected). See "rejects a
      // <!--> (abrupt-closing comment) bypass" in web-fetch-tool.test.ts.
      const close = html.indexOf('-->', lt + 2);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      // Doctype/processing-instruction — no id/name of interest, no depth effect.
      const gt = html.indexOf('>', lt);
      if (gt === -1) return; // no '>' anywhere later — nothing further can ever match
      i = gt + 1;
      continue;
    }
    let pos = lt + 1;
    const isClose = html[pos] === '/';
    if (isClose) pos++;
    const nameStart = pos;
    while (pos < n && isNameChar(html.charCodeAt(pos))) pos++;
    if (pos === nameStart) {
      // '<' not followed by a valid tag-name start (stray '<', '<3', etc.) —
      // not a tag. Advance past just this '<'; the next indexOf resumes from
      // here, so this stays one forward pass over the whole string.
      i = lt + 1;
      continue;
    }
    // Folds ONLY this bounded tag-name slice (a handful of characters, never
    // the whole document) and the result is used solely for value equality
    // (VOID_ELEMENTS.has, 'script'/'style' checks) — never as a source of an
    // offset back into `html`, which is what made the old document-wide
    // `lower` copy unsafe.
    const name = html.slice(nameStart, pos).toLowerCase();
    const gt = html.indexOf('>', pos);
    if (gt === -1) return; // CRITICAL early-exit — see WHY above
    const selfClosed = html.charCodeAt(gt - 1) === 47; // '/'
    // Raw-text elements (script/style) only actually open a raw-text region
    // when NOT self-closed.
    //
    // WHY (CRITICAL, round 6, 2026-08-06 review — the mismatch flagged by the
    // round-5 fixer): htmlparser2's tokenizer resets `isSpecial = false` the
    // INSTANT it sees the self-closing `/>` on a <script>/<style> tag
    // (Tokenizer.js `stateInSelfClosingTag`) — a self-closed raw-text tag
    // NEVER reaches the `InSpecialTag` raw-text state, so it swallows nothing
    // after it as text. The old code called findRawTextEnd unconditionally
    // for any `<script`/`<style` OPEN tag, self-closed or not — so
    // `<script/>` with no LATER real `</script...` anywhere in the document
    // (the attacker's whole point) made findRawTextEnd return -1 and this
    // walker jump straight to `n`, treating every tag for the REST of the
    // document — real, attacker-supplied depth included — as "still inside
    // the script" and invisible to the depth count.
    //
    // On its own that undercount is inert: linkedom's Parser (htmlparser2,
    // HTML mode, not recognizeSelfClosing — verified in
    // node_modules/linkedom/esm/shared/parse-from-string.js, which passes
    // only `{ xmlMode: !isHTML }`) also ignores the self-closing slash on a
    // non-void, non-foreign element, so `<script/>` itself stays OPEN and
    // everything after it becomes its real DOM children — and Readability's
    // own parse() removes every <script>/<style> subtree (`_removeScripts`,
    // `_prepDocument`) before the expensive `_grabArticle()` pass ever runs,
    // so a swallowed-whole subtree is safe by accident.
    // BUT htmlparser2's `openImpliesClose` map (Parser.ts) closes an open
    // `script` the instant a NEW `<body>` tag appears while `script` is the
    // top of the parse stack (`["body", new Set(["head","link","script"])]`)
    // — so `<script/><body>` closes the (empty) script immediately and
    // everything typed after `<body>` is real, un-stripped top-level
    // content, not a script descendant. Measured on this machine through
    // WebFetchTool.execute: `'<html><head></head><script/><body>' +
    // '<div>'.repeat(14_895) + '</body></html>'` (74,523 bytes, 14,902 '<'
    // characters — under MAX_TAGS) took 5,518ms (guard let it through,
    // Readability ran on a genuinely ~14,895-deep, un-stripped document and
    // eventually threw "Maximum call stack size exceeded" — 5.5s of
    // main-thread block before that throw). Control (same divs, no
    // script/body trick): 3ms, rejected as normal. See "rejects the
    // <script/><body> escape-hatch bypass" in web-fetch-tool.test.ts.
    if (!isClose && !selfClosed && (name === 'script' || name === 'style')) {
      // See findRawTextEnd's WHY block (BLOCKER B2) for why this is no
      // longer a literal '</script>'/'</style>' search.
      const end = findRawTextEnd(html, name, gt + 1);
      i = end === -1 ? n : end;
      continue;
    }
    onTag({ name, isClose, selfClosed });
    i = gt + 1;
  }
}

/** Cheap O(n) rejection of pathological HTML BEFORE the quadratic Readability
 *  parse. Returns an honest error message when the page is too broad or too
 *  deeply nested to extract safely; returns null when it is safe to proceed. */
function tooComplexToExtract(rawHtml: string): string | null {
  // Breadth proxy: count '<' across the whole string (includes text-node '<' and
  // comments — a deliberate cheap over-approximation). Bounds huge tables /
  // anchor lists whose cost comes from tag COUNT, not depth. This regex is a
  // single literal-character scan (no backtracking risk), so it stays O(n)
  // regardless of content shape — it was never the quadratic part.
  const tagCount = (rawHtml.match(/</g) || []).length;
  if (tagCount > MAX_TAGS) {
    return 'WebFetch: this page is too large or deeply nested to extract safely. Try a more specific URL or a printer-friendly/article version.';
  }
  // Depth: single pass via walkTags, tracking a running open/close depth and
  // its max. Increment on a non-void, non-self-closed open tag; decrement on a
  // close tag; clamp at 0 so malformed close-heavy input can't underflow.
  //
  // WHY walkTags and not the previous /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g
  // (CRITICAL, 2026-08-06 re-review): that regex's [^>]*? is a lazy quantifier —
  // when a '<tagname' is never followed by '>', the match attempt fails and the
  // engine retries starting at the NEXT character, re-scanning to the end again.
  // Measured on this machine: a 5.14MB body of 14,999 unterminated '<a' (zero
  // '>' anywhere) took 9,965ms inside WebFetchTool.execute — the tag-count
  // pre-check above does not save it, because it counts '<' characters, not
  // parsed tags, so this exact shape sits right under MAX_TAGS and reaches this
  // scan. See "does not freeze" test pinning the fixed number.
  let depth = 0;
  let maxDepth = 0;
  // Foreign-context (SVG/MathML) nesting counter — see the WHY block on
  // `exemptSelfClose` below for what this corrects. Only a running COUNT is
  // needed (not a stack of element names), because this guard only ever asks
  // "are we inside svg/math right now", mirroring htmlparser2's own
  // `foreignContext` stack (Parser.ts) at that single-bit granularity.
  let foreignDepth = 0;
  walkTags(rawHtml, (tag) => {
    const isForeignRoot = tag.name === 'svg' || tag.name === 'math';
    if (tag.isClose) {
      depth = Math.max(0, depth - 1);
      if (isForeignRoot) foreignDepth = Math.max(0, foreignDepth - 1);
      return;
    }
    if (isForeignRoot) foreignDepth++;
    // WHY selfClosed only exempts depth INSIDE foreign context (CRITICAL,
    // round 6, 2026-08-06 review): linkedom's Parser (htmlparser2, HTML mode
    // — see the WHY block on walkTags' script/style branch above for the
    // verification) ignores the self-closing slash on ANY non-void,
    // non-foreign element — `<div/>`, `<span/>`, `<script/>`, etc. all stay
    // OPEN on the real parse stack exactly like `<div>` would, until an
    // explicit close or EOF. It is honored ONLY inside an <svg>/<math>
    // subtree (`this.foreignContext[0]` in `onselfclosingtag`, Parser.ts).
    // The old code exempted EVERY selfClosed non-void tag from the depth
    // count unconditionally — correct for an SVG icon's self-closing
    // <path/>/<circle/> shapes, but WRONG for ordinary HTML, and exploitable
    // WITHOUT any script/style trick at all. Measured on this machine
    // through WebFetchTool.execute: `'<html><body>' + '<div/>'.repeat(700) +
    // 'x</body></html>'` (a page with no raw-text tag anywhere) took
    // 2,812ms — Readability ran on a document that was genuinely 700
    // elements deep, because maxDepth stayed 0 for the whole scan (every one
    // of those 700 real, still-open <div>s was excused as "self-closed, so
    // like a void element"). Control (same divs, real '</div>' closers):
    // 2-4ms, rejected as normal. See "rejects self-closing non-void tags
    // that stay open per the real HTML parser (no script/style needed)" in
    // web-fetch-tool.test.ts.
    //
    // KNOWN LIMITATION: htmlparser2 also flips back to normal (non-foreign)
    // self-closing rules inside a small set of SVG/MathML "integration
    // points" (`<foreignObject>`, `<desc>`, `<title>` inside <svg>; `<mi>`,
    // `<mo>`, `<mn>`, `<ms>`, `<mtext>`, `<annotation-xml>` inside <math> —
    // `htmlIntegrationElements` in Parser.ts). This counter does not track
    // those, so a page would need real SVG content AND one of those specific
    // integration elements AND many self-closing tags nested inside THAT to
    // still undercount — a narrow, deliberately-crafted shape ordinary
    // content does not produce, and strictly narrower than the gap that
    // existed before this fix (which had no foreign-context awareness at
    // all, so it was wrong for the whole document, not just inside these
    // rare integration points).
    const exemptSelfClose = tag.selfClosed && foreignDepth > 0;
    if (!exemptSelfClose && !VOID_ELEMENTS.has(tag.name)) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    }
    // Self-closed svg/math ROOT elements close themselves immediately (net
    // zero): htmlparser2 pushes foreignContext=true in emitOpenTag, THEN
    // reads it back in onselfclosingtag for that SAME tag, then immediately
    // pops it in closeCurrentTag. Without this line, a bare `<svg/>` would
    // leave foreignDepth stuck open forever (nothing later will emit a
    // matching close for it), wrongly exempting every self-closing tag for
    // the REST of the document — reopening the exact bug this fixes.
    if (isForeignRoot && tag.selfClosed) foreignDepth = Math.max(0, foreignDepth - 1);
  });
  if (maxDepth > MAX_DEPTH) {
    return 'WebFetch: this page is too large or deeply nested to extract safely. Try a more specific URL or a printer-friendly/article version.';
  }
  return null;
}

/** Tag-strip to readable text — the guard-path fallback that runs on EXACTLY
 *  the input tooComplexToExtract() just rejected, so it must not reintroduce
 *  the freeze the guard exists to prevent.
 *
 *  WHY this is a hand-written scan and not a regex (CRITICAL, 2026-08-06
 *  review): the previous implementation used /<[^>]*>/g and
 *  /<script[\s\S]*?<\/script>/gi and its comment claimed this was O(n). That
 *  claim was never measured and is false: both regexes backtrack — when a '<'
 *  or '<script' is never followed by its terminator, the engine retries the
 *  match starting at every subsequent character, each retry re-scanning to the
 *  end of the string. Measured on this machine: /<[^>]*>/g against a run of
 *  200,000 unterminated '<' characters (200KB — far under the 5MB body cap)
 *  took 12,194ms. That exact shape (many '<' with no '>') is what makes
 *  tooComplexToExtract() reject a page in the first place (it counts every
 *  '<', matched or not) — so the "safe" fallback was reopening precisely the
 *  main-thread freeze the guard exists to prevent.
 *
 *  This scan is linear BY CONSTRUCTION rather than by claim: cursor `i` only
 *  ever moves forward, and every indexOf()/startsWith() lookahead begins where
 *  the previous one finished, so the ranges scanned across the whole call
 *  never overlap — total work is bounded by one pass over `html` regardless of
 *  content shape. Concretely, an unterminated tag or script/style block is
 *  handled by jumping straight to the end of the string ONCE, never retried
 *  character-by-character. Measured on the same 200,000-char adversarial
 *  input this replaces: see "does not freeze on 200,000 unterminated '<'
 *  characters" in tests/web-fetch-tool.test.ts for the pinned number.
 *
 *  WHY there is no `lower = html.toLowerCase()` here (Important finding,
 *  round 4, 2026-08-06 review): an earlier version of this function built
 *  exactly that, then indexed it with offsets computed against `html`'s own
 *  length — the same html/lower index-aliasing bug indexOfFold's comment
 *  above documents for walkTags, independently reintroduced here. `'İ'`
 *  (U+0130) is the ONE character in Unicode whose `.toLowerCase()` grows by
 *  a UTF-16 unit ('i' + a combining dot), so a document with an 'İ' anywhere
 *  ahead of a `<script>`/`<style>` tag shifted every check after it by a
 *  constant offset. Measured, with the offset shifted by exactly 100 (a
 *  100-character 'İ' prefix): `'İ'.repeat(100) + '<script>JUNK</script>' +
 *  'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK'` returned text
 *  containing "JUNK" (the script body leaked as visible prose, because the
 *  shifted check failed to recognize the REAL `<script>` tag as one, so its
 *  body was walked as ordinary markup) and — because that same shift then
 *  made an UNRELATED later `<p>` tag land exactly on the shifted-back
 *  position of the real "<script" text and get misidentified AS a script
 *  open tag, whose "closer" search then found nothing and fell through to
 *  `n` — dropped every character from that `<p>` onward, silently deleting
 *  "DROPME_TEXT_HERE" and "TAIL_OK" both. The identical input with 'İ'
 *  replaced by 'q' (same length, no expansion) is correct on both counts.
 *  Fixed the same way as walkTags: fold only the bounded needle
 *  ("<script"/"<style"/their closers) via foldStartsWith/indexOfFold, never
 *  the whole document — see "does not leak script source or drop visible
 *  text on an İ-prefixed too-complex fallback" in web-fetch-tool.test.ts. */
export function stripToText(html: string): string {
  const n = html.length;
  const parts: string[] = [];
  let i = 0;
  let textStart = 0;
  while (i < n) {
    if (html.charCodeAt(i) !== 60 /* '<' */) { i++; continue; }
    if (i > textStart) parts.push(html.slice(textStart, i));
    const isScript = foldStartsWith(html, '<script', i);
    if (isScript || foldStartsWith(html, '<style', i)) {
      const closer = isScript ? '</script>' : '</style>';
      const closeIdx = indexOfFold(html, closer, i);
      // Not found: treat the rest of the document as inside this block and
      // stop — do NOT retry the search from i+1, which is what made the old
      // regex quadratic on input shaped like this.
      i = closeIdx === -1 ? n : closeIdx + closer.length;
    } else {
      const gt = html.indexOf('>', i);
      // Unterminated tag: drop everything after it rather than re-scanning
      // for a '>' that will never arrive.
      i = gt === -1 ? n : gt + 1;
    }
    parts.push(' ');
    textStart = i;
  }
  if (n > textStart) parts.push(html.slice(textStart, n));
  return parts.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Same script/style removal as stripToText's first phase, but keeps every
 *  other byte (including other markup) instead of collapsing it to text. Used
 *  only to build a comparable denominator for looksJsRendered's density check
 *  below — see that function's WHY comment. Uses the same monotonic-cursor
 *  technique as stripToText above, for the same reason: linear regardless of
 *  content shape.
 *
 *  WHY there is no `lower = html.toLowerCase()` here either (Important
 *  finding, round 4, 2026-08-06 review): this function carried the identical
 *  html/lower index-aliasing bug as the old stripToText — see stripToText's
 *  WHY comment for the mechanism. Here the consequence was on the OTHER side
 *  of looksJsRendered's ratio: the aliasing could make this function fail to
 *  recognize a real `<script>` tag as one (same shifted-check failure), so
 *  its bytes stayed IN the returned string, inflating the density
 *  denominator and pushing the ratio down. Measured: a Next.js-shaped shell
 *  (`<div id="__next"></div>` + a `__NEXT_DATA__`-bearing `<script>`) that
 *  correctly reports `looksJsRendered === true` flipped to `false` once 60
 *  'İ' characters were placed before the `<script>` tag — meaning ordinary
 *  Turkish-language pages (İstanbul, İzmir…) could silently lose the
 *  JS-rendered disclosure, not just adversarial input. Fixed with the same
 *  foldStartsWith/indexOfFold technique as stripToText. */
function withoutScriptAndStyle(html: string): string {
  const n = html.length;
  const parts: string[] = [];
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const isTag = html.charCodeAt(i) === 60 && (foldStartsWith(html, '<script', i) || foldStartsWith(html, '<style', i));
    if (!isTag) { i++; continue; }
    if (i > textStart) parts.push(html.slice(textStart, i));
    const closer = foldStartsWith(html, '<script', i) ? '</script>' : '</style>';
    const closeIdx = indexOfFold(html, closer, i);
    i = closeIdx === -1 ? n : closeIdx + closer.length;
    textStart = i;
  }
  if (n > textStart) parts.push(html.slice(textStart, n));
  return parts.join('');
}

// Cap on how much raw HTML the guard-path fallback (below) will turn into
// plain text. WHY (Important finding, 2026-08-06 review): the fallback exists
// to give the model SOMETHING useful when structured extraction was refused,
// not to render an entire document up to the 5MB body cap as plain text — a
// multi-megabyte tag-soup page would otherwise return megabytes of largely
// unreadable text. This is independent of the CRITICAL fix above (stripToText
// is linear now, so this cap is about usefulness, not runtime safety) and does
// NOT change MAX_TAGS, MAX_DEPTH, or the 5MB body cap itself.
const FALLBACK_CHAR_CAP = 200_000;

/** stripToText, bounded to FALLBACK_CHAR_CAP raw characters, for the guard
 *  (too-complex) path only. The JS-render density check below needs the FULL
 *  text and calls stripToText directly. */
function stripToTextCapped(html: string): { text: string; truncated: boolean } {
  const capped = html.length > FALLBACK_CHAR_CAP;
  return { text: stripToText(capped ? html.slice(0, FALLBACK_CHAR_CAP) : html), truncated: capped };
}

// --- JS-rendered-page disclosure (task 12) ------------------------------------
// Diagnosed 2026-08-01: WebFetch returned a clean, well-under-cap extraction of
// vitest.dev/config/ and the model confidently reported the `include` option
// "is not documented" — the content simply never arrives in the server's HTML;
// it is fetched by client-side JS after the page loads. Extraction-coverage ratio
// CANNOT be the signal (measured 70.3% on this false-negative page vs 69.1% on a
// known-good server-rendered page — indistinguishable), so detection instead
// combines a framework marker with raw text density.

/** Markers of a client-rendered app shell. */
const JS_APP_MARKERS = /__VP_HASH_MAP__|__NEXT_DATA__|__NUXT__|__remixContext|__sveltekit|window\.__INITIAL_STATE__/;
const EMPTY_ROOT = /<div id="(?:root|app|__next)"\s*>\s*<\/div>/i;
/** Visible-text-to-bytes ratio below which a page is mostly scaffolding. The
 *  denominator excludes <script>/<style> bytes — see the WHY comment on
 *  looksJsRendered below for why that matters. Re-measured on the two
 *  committed fixtures after that fix (2026-08-06): vitest-config.html (the
 *  false-negative page from the 2026-08-01 incident) 7.18%; asyncio.html
 *  (server-rendered, near-identical extraction ratio before this fix) 19.07%.
 *  Both these are what the committed test fixtures actually measure, not the
 *  5.3%/16.0% an earlier draft of this comment claimed. 10% still sits in the
 *  gap between them.
 *
 *  WHY the direction of this change matters (Minor finding, 2026-08-06
 *  re-review): excluding script/style from the denominator can only RAISE the
 *  ratio (the denominator only ever shrinks), so this change can only produce
 *  false NEGATIVES (a JS-rendered page slipping under the floor undetected),
 *  never false positives. Concretely, on vitest-config.html — the fixture
 *  that MUST stay flagged — the margin between its density and the 10% floor
 *  shrank from 4.64pp (old, raw html.length denominator: 5.36%) to 2.82pp
 *  (new: 7.18%). That margin is now the safety cushion: a real VitePress page
 *  with a larger __VP_HASH_MAP__ blob than this fixture's would push the
 *  ratio closer to 10% and could clear the floor, silently losing the
 *  JS-render disclosure. If that starts happening, raise TEXT_DENSITY_FLOOR,
 *  not the denominator logic — lowering the floor is the direction that
 *  re-admits false negatives; nothing here should ever LOWER it. */
const TEXT_DENSITY_FLOOR = 0.10;

/** Core of the JS-render check, taking an already-computed stripped text so
 *  callers that need that text anyway (execute(), below) don't pay for a
 *  second stripToText() pass over the same html. */
function jsRenderDensity(html: string, strippedText: string): boolean {
  const hasMarker = JS_APP_MARKERS.test(html) || EMPTY_ROOT.test(html);
  if (!hasMarker) return false;
  const denominator = withoutScriptAndStyle(html).length;
  return strippedText.length / Math.max(denominator, 1) < TEXT_DENSITY_FLOOR;
}

/** True when the served HTML looks like an app shell whose content arrives via
 *  JavaScript. We CANNOT know what is missing — from the response's point of view
 *  nothing is — so callers must phrase the disclosure non-committally per
 *  docs/error-message-standards.md.
 *
 *  WHY the denominator excludes <script>/<style> bytes (Important finding,
 *  2026-08-06 review): stripToText already strips script/style bodies out of
 *  the NUMERATOR, but the denominator used to be the raw html.length, which
 *  still counted them — so a routine SSR hydration blob (e.g. Next.js'
 *  __NEXT_DATA__) deflated the ratio regardless of whether the visible prose
 *  was complete. A simulated SSR page with full article content plus a normal
 *  __NEXT_DATA__ blob measured 7.31% under the old (html.length) denominator —
 *  misfiring below the 10% floor on a page where nothing was missing — and
 *  89.29% under this one. See the "SSR page with a hydration blob" test. */
export function looksJsRendered(html: string): boolean {
  return jsRenderDensity(html, stripToText(html));
}

// --- URL fragment resolution (task 13, redesigned round 3 2026-08-06) ----------

// WHY this queries the parsed DOM instead of hand-scanning raw HTML a fourth
// time (design change, round 3): htmlToMarkdown already runs the page through
// linkedom's real HTML parser to build a `document` for Readability. Every
// prior round's fragment-resolution bug — the CRITICAL/IMPORTANT/MINOR
// findings this round, and the two CRITICAL regexes fixed in rounds 1–2
// (ID_ATTR_RE, ANCHOR_NAME_RE) — was a hand-rolled approximation of what a
// real parser already does correctly: attribute quoting (double/single/
// unquoted), script/style/comment/raw-text bodies, `>` inside a quoted
// attribute value. linkedom handles all of it for free, so the fix is to
// stop re-approximating and ask the parser directly.
//
// WHY the DOM lookup happens BEFORE Readability.parse() runs, not after (this
// is the one place this round's design deviates from a literal "have
// resolveFragment query the document" reading — see findAnchor below):
// Readability's own workflow doc comment says "4. Replace the current DOM
// tree with the new one" — it mutates `this._doc` in place, moving matched
// content into a new detached container and removing everything else during
// cleanup (verified by reading Readability.js: `_grabArticle` does
// `articleContent.appendChild(sibling)`, which MOVES real nodes, not clones).
// So the SAME document object queried after Readability has run may no
// longer contain an id that genuinely existed in the served page — which
// would misreport a real "the anchor exists but extraction dropped it" as a
// false "the anchor never existed" (`absent` instead of `dropped`). The fix:
// query the pristine, pre-Readability document once (findAnchor), carry
// forward only its small boolean/exactCase verdict, and combine that with
// the markdown once Readability has finished (classifyFragment). See
// WebFetchTool.execute below for the call order this requires.

/** Escapes a value for safe interpolation into a double-quoted CSS attribute
 *  selector string (`a[name="…"]` below). The fragment is attacker-controlled
 *  (it comes straight off the request URL), so a raw `"` or `\` in it must
 *  not be able to break out of the quoted value. Not a general CSS.escape
 *  substitute — sufficient because that's the only thing it needs to do. */
function escapeAttrSelectorValue(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

/** Resolves a URL fragment against an ALREADY-PARSED linkedom document. Exact
 *  match first (`getElementById`, `a[name="…"]`); falls back to a
 *  case-insensitive scan of every id/name VALUE in the document, same policy
 *  the hand-rolled version used (Minor finding, prior rounds: HTML `id` is
 *  case-sensitive, but real pages do sometimes get linked with the "wrong"
 *  case, so a case-insensitive hit is still reported as useful — just
 *  flagged as inexact via `exactCase`); then a final fallback that also
 *  tolerates the attribute NAME itself being written in a non-lowercase
 *  spelling (`<h2 ID="x">`, `<a NAME="x">`), which linkedom does not
 *  normalize the way a conforming HTML parser does (Important finding,
 *  round 4, 2026-08-06 — see the loop below).
 *
 *  MUST be called before the same document is handed to Readability — see
 *  the WHY block above. */
function findAnchor(document: Document, fragment: string): { exactCase: boolean } | null {
  if (document.getElementById(fragment)) return { exactCase: true };
  if (document.querySelector(`a[name="${escapeAttrSelectorValue(fragment)}"]`)) return { exactCase: true };
  const lowerFragment = fragment.toLowerCase();
  // Array.from (not a direct for-of) — linkedom's NodeListOf, reached through
  // the ambient lib.dom Document type parseHTML's return type resolves to,
  // doesn't type-check as directly iterable under this repo's tsconfig even
  // though it's iterable at runtime; Array.from sidesteps that without a cast.
  for (const el of Array.from(document.querySelectorAll('[id]'))) {
    const id = el.getAttribute('id');
    if (id && id.toLowerCase() === lowerFragment) return { exactCase: false };
  }
  for (const a of Array.from(document.querySelectorAll('a[name]'))) {
    const name = a.getAttribute('name');
    if (name && name.toLowerCase() === lowerFragment) return { exactCase: false };
  }
  // FALLBACK (Important finding, round 4, 2026-08-06): every probe above
  // relies on getElementById or the `[id]`/`a[name]` CSS selectors, all of
  // which match against the LITERAL attribute name "id"/"name". linkedom,
  // unlike a conforming HTML parser, does NOT ASCII-lowercase attribute
  // NAMES (only values pass through untouched too, but it's the name that
  // matters here): for `<h2 ID="upattr">`, `getAttributeNames()` returns
  // `["ID"]`, so `getElementById('upattr')` is null AND `[id]` matches zero
  // elements -- every probe above misses. Same for `<a NAME="legacyU">`.
  // Verified directly against linkedom: `parseHTML('<h2 ID="upattr">...')`
  // gives `document.querySelectorAll('[id]').length === 0`. Both spellings
  // are legal HTML5, and both used to work: the pre-round-3 `parseAttrs`
  // lowercased the attribute name before comparing, so this is a regression
  // this round introduced, not a pre-existing gap. Walk every element's OWN
  // attribute names case-insensitively as the last resort -- deliberately
  // placed after every cheaper selector-based probe above (and therefore
  // only paid for on a miss), since the common case is a lowercase
  // `id="..."` the fast path already resolves.
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attrName of el.getAttributeNames()) {
      const lowerAttrName = attrName.toLowerCase();
      const isIdAttr = lowerAttrName === 'id';
      const isAnchorNameAttr = lowerAttrName === 'name' && el.tagName?.toLowerCase() === 'a';
      if (!isIdAttr && !isAnchorNameAttr) continue;
      const value = el.getAttribute(attrName);
      if (!value) continue;
      if (value === fragment) return { exactCase: true };
      if (value.toLowerCase() === lowerFragment) return { exactCase: false };
    }
  }
  return null;
}

/** Given an already-resolved DOM anchor match (or null) and the extracted
 *  markdown, decides found / dropped / absent. Split out from findAnchor so
 *  production can query the DOM once, before Readability mutates it, and
 *  bring forward only the small `{ exactCase }` result to combine with the
 *  markdown once extraction has finished (see the WHY block above).
 *
 *  WHY matching goes through anchor hrefs and not heading text: VitePress emits
 *  `## Config Options [​](#config-options)`, so slugifying the heading text yields
 *  "config-options-config-options" and misses. The `id="..."` attributes in the raw
 *  HTML are authoritative and independent of markdown rendering.
 *
 *  `bodyTruncated` scopes the `absent` result's wording (Important finding,
 *  prior round): when the fetched body was cut off at the 5MB cap, "this
 *  anchor does not exist" is a claim about bytes that were never read, not
 *  about the page. */
function classifyFragment(
  anchor: { exactCase: boolean } | null,
  markdown: string,
  fragment: string,
  bodyTruncated: boolean,
):
  | { kind: 'found'; section: string; exactCase: boolean }
  | { kind: 'dropped'; exactCase: boolean }
  | { kind: 'absent'; bodyTruncated: boolean } {
  if (anchor === null) return { kind: 'absent', bodyTruncated };
  // Markdown heading/slug text is already case-normalized by the renderer
  // (VitePress etc. lowercase slugs regardless of source id case), so this
  // half of the match stays a lowercase comparison.
  const frag = fragment.toLowerCase();
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (l) => /^#{1,6} /.test(l) && (l.toLowerCase().includes(`(#${frag})`) || slugify(l) === frag),
  );
  if (start === -1) return { kind: 'dropped', exactCase: anchor.exactCase };
  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { kind: 'found', section: lines.slice(start, end).join('\n').trim(), exactCase: anchor.exactCase };
}

/** Test/convenience entry point matching the pre-round-3 API shape: parses
 *  `rawHtml` itself and resolves the fragment against the result. NOT used by
 *  WebFetchTool.execute in production — that path reuses the single document
 *  it's about to hand to Readability and must query it BEFORE Readability
 *  mutates it (see the WHY block above), so it calls findAnchor and
 *  classifyFragment directly instead of parsing the page a second time here.
 *  Kept as the public surface for tests and any future non-pipeline caller
 *  that just wants a straight answer for one page. */
export function resolveFragment(
  rawHtml: string,
  markdown: string,
  fragment: string,
  bodyTruncated = false,
):
  | { kind: 'found'; section: string; exactCase: boolean }
  | { kind: 'dropped'; exactCase: boolean }
  | { kind: 'absent'; bodyTruncated: boolean } {
  const { document } = parseHTML(rawHtml);
  return classifyFragment(findAnchor(document, fragment), markdown, fragment, bodyTruncated);
}

/** Heading text → slug, with any trailing anchor link removed first. */
function slugify(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/\[.*?\]\(#.*?\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Runs Readability + turndown against an ALREADY-PARSED document (the
 *  caller must have finished any DOM queries of its own first — see
 *  findAnchor's WHY block above, since this call mutates `document` in
 *  place). `rawHtml` is only the last-resort fallback source if Readability
 *  finds no article AND the mutated document somehow has no body. */
function htmlToMarkdown(document: Document, rawHtml: string): { title: string | null; markdown: string } {
  // linkedom's parsed document satisfies Readability's DOM contract at runtime,
  // but its typings don't match @mozilla/readability's `Document` param — cast
  // narrowly here rather than pull in a jsdom-shaped global Document type.
  const article = new Readability(document as unknown as Document).parse();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  if (article?.content) return { title: article.title ?? null, markdown: turndown.turndown(article.content) };
  // Readability found no article (a dashboard, an index page…) — fall back to the
  // whole body so the model still gets SOMETHING structured, never a silent empty.
  const body = document.body?.innerHTML ?? rawHtml;
  return { title: document.title || null, markdown: turndown.turndown(body) };
}

export const WebFetchTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'WebFetch',
  description:
    'Fetch a web page and return its main content as Markdown. Only public http/https URLs — private and local addresses are blocked. Large pages are truncated.',
  // Compact form for small local models (simplified presentation).
  shortDescription: 'Fetch a public web page (http/https) and return its main content as Markdown.',
  inputSchema,
  // WHY this exists as a static field AND gets copied verbatim into every
  // `bounds.moreHint` below (fix: WebFetch declares its body caps instead of
  // hand-writing them): `bounds` can only be built inside execute()'s object
  // literals, which can't reference the const this file is still constructing
  // (`WebFetchTool` isn't assigned yet at that point) — so the string is
  // duplicated by hand, same as Bash's and Read's `moreHint` fields do. This is
  // WebFetch's one genuine widening vocabulary (it has no offset/limit-style
  // parameter to page through) and also composeNotice's no-bounds fallback
  // (Task 19) for the rare defineTool pipeline-cap-only case.
  moreHint: 'fetch a more specific URL, or a narrower section of the page',
  permissionSubject: (args) => args.url,
  async execute(args, ctx) {
    let res: Response, finalUrl: string;
    try {
      ({ res, finalUrl } = await guardedFetch(args.url, { signal: ctx.signal, ...testHooks }));
    } catch (err) {
      if (err instanceof NetGuardError) return { text: `WebFetch blocked: ${err.message}`, isError: true };
      throw err; // defineTool's catch turns it into an actionable error result
    }
    if (!res.ok) {
      return { text: `WebFetch failed: ${finalUrl} answered HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ''}.`, isError: true };
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml');
    const isText = TEXT_TYPES.test(contentType);
    // A bare/misconfigured HTML server may omit content-type entirely. Don't refuse
    // outright: defer the decision until after we've read the body and can sniff it
    // (below). A NON-empty, non-html, non-text type IS a real binary — refuse now,
    // before downloading it.
    const noContentType = contentType.trim() === '';
    if (!isHtml && !isText && !noContentType) {
      return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
    }
    // CHARSET NOTE: readBodyCapped decodes as UTF-8 unconditionally (it lives in
    // net-guard.ts — not editable this round). A shift_jis / latin-1 page therefore
    // renders as mojibake. Accepted for a preview-grade extraction; a proper
    // charset-aware decode is deferred.
    const { text: raw, truncated } = await readBodyCapped(res, MAX_BODY_BYTES);
    // No content-type header: sniff the decoded body. Real HTML starts (after
    // optional whitespace/BOM) with a doctype or <html>. Anything else stays a
    // refusal — we couldn't determine it's readable text/html.
    if (noContentType) {
      if (/^\s*<(?:!doctype\s+html\b|html\b)/i.test(raw)) {
        isHtml = true;
      } else {
        return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
      }
    }
    const header = [
      args.prompt ? `Fetched for: ${args.prompt}` : null,
      `Source: ${finalUrl}`,
    ].filter(Boolean).join('\n');
    if (!isHtml) {
      return {
        text: `${header}\n\n${raw}`,
        // Fix: declare the 5MB cap via `bounds` instead of hand-writing
        // "[body truncated at 5MB]" into `text` — the server never told us how
        // much MORE there was past MAX_BODY_BYTES, so `total` MUST be `null`
        // (composeNotice renders that as "at least N"); inventing a total here
        // is the exact dishonesty this contract exists to remove.
        //
        // NOT the same defect as BLOCKER B1 below (round 5, 2026-08-06
        // review — checked deliberately, since this branch has the identical
        // `{ shown: MAX_BODY_BYTES, ... }` shape): B1 was `shown` describing
        // bytes that were fetched but then mostly DISCARDED by extraction
        // before reaching `text`. Here `raw` is embedded in `text` VERBATIM —
        // there is no extraction step for non-HTML content — so every one of
        // the (up to) MAX_BODY_BYTES bytes readBodyCapped decoded into `raw`
        // really is present in what the model reads. `shown: MAX_BODY_BYTES`
        // stays an honest count of bytes actually shown, not an overstatement.
        bounds: truncated
          ? { shown: MAX_BODY_BYTES, total: null, unit: 'bytes' as const, moreHint: 'fetch a more specific URL, or a narrower section of the page' }
          : undefined,
      };
    }
    // Needed by both the too-complex fallback below and the normal path —
    // compute once up front.
    const hash = (() => { try { return new URL(finalUrl).hash.replace(/^#/, ''); } catch { return ''; } })();
    // DoS guard: never run the synchronous ~quadratic Readability parse on
    // pathological HTML. But WHY this no longer hard-fails (2026-08-06): the guard
    // is specifically about Readability's cost, and tag-stripping is now genuinely
    // linear (see stripToText's WHY comment) and safe on any input — so we can
    // still return honest content. The old refusal left the model with nothing
    // and no way forward (2026-08-01 review, finding #1).
    const tooComplex = tooComplexToExtract(raw);
    if (tooComplex) {
      // WHY stripToTextCapped (not stripToText) here (Important finding,
      // 2026-08-06 review): this branch previously called the unbounded
      // stripToText and silently returned an entire multi-megabyte tag-soup
      // document as plain text — not a truncation-SAFETY issue (stripToText is
      // linear on any input) but a usefulness one: FALLBACK_CHAR_CAP bounds it
      // to something a model can actually read.
      const { text: fallbackText, truncated: fallbackCapped } = stripToTextCapped(raw);
      // Fix: declare the 200KB scan cap via `bounds` instead of hand-writing
      // "Showing only the first NKB..." into `text`. WHY this cap — not the 5MB
      // network cap — takes the single `bounds` slot when BOTH fire on the same
      // response (only one `bounds` can ride a ToolResultPayload): whenever
      // `truncated` (the 5MB cap) is true, `raw` decodes to well over 200,000
      // UTF-16 code units (5,242,880 bytes is at minimum ~2.6M units even in the
      // all-4-byte-codepoint worst case), so `fallbackCapped` is unconditionally
      // also true — the 200KB cap is the one that actually bounds what the
      // model reads. Its total (raw.length, the HTML actually scanned for this
      // fallback) is known exactly, unlike the 5MB cap's total. The 5MB fact is
      // not dropped: bodyCapNote below discloses it as plain prose whenever it
      // also fired — a fact, not advice, so it isn't the retired "how do I get
      // more" wording this contract removes.
      const bounds = fallbackCapped
        ? {
            shown: FALLBACK_CHAR_CAP,
            total: raw.length,
            unit: 'chars' as const,
            // Verbatim copy of WebFetchTool's own `moreHint` — see its WHY comment.
            moreHint: 'fetch a more specific URL, or a narrower section of the page',
          }
        : undefined;
      const bodyCapNote = truncated
        ? '\n\n[The response body itself was cut off at the 5MB fetch cap before this extraction ran — the live page may be larger than what was received.]'
        : '';
      // WHY this is general-and-non-committal, not "no anchor named X" (round 3
      // design change): this branch never parses the page — that's the whole
      // point of the guard — so there is no DOM to check the fragment against.
      // Per docs/error-message-standards.md, a claim we cannot support (a
      // categorical "this anchor does not exist") is worse than saying plainly
      // that the check could not be done.
      const fragmentNote = hash
        ? `\n\n[This page could not be parsed for structured extraction, so whether "#${hash}" exists could not be checked.]`
        : '';
      return {
        text: `${header}\n\n[This page is too large or deeply nested for structured extraction, so this is a simplified extraction: plain text with no headings, links, or code formatting.]\n\n${fallbackText}${fragmentNote}${bodyCapNote}`,
        bounds,
      };
    }
    // Single parse of this page, reused for both fragment resolution and
    // Readability extraction below — see the WHY block above
    // classifyFragment for why the fragment lookup MUST happen here, before
    // htmlToMarkdown hands this same `document` to Readability and Readability
    // mutates it in place.
    const { document } = parseHTML(raw);
    const anchorMatch = hash ? findAnchor(document, hash) : null;
    const { title, markdown } = htmlToMarkdown(document, raw);
    // Minor finding (2026-08-06 review): stripToText(raw) used to be recomputed
    // separately for the density check and for the KB figure in jsNote below —
    // compute it once here and pass it into both.
    const strippedRaw = stripToText(raw);
    // Honest, non-committal disclosure: state what was observed, never guess what
    // is absent. Without this a JS-rendered docs page returns a confident preamble
    // and the model reports "the docs do not document X" (2026-08-01 review).
    const jsNote = jsRenderDensity(raw, strippedRaw)
      ? `\n\n[This page is a JavaScript-rendered app. The server sent ${(strippedRaw.length / 1024).toFixed(1)} KB of text; content that loads in a browser is not included. If a section you expected is absent, it is likely rendered client-side.]`
      : '';
    // A fragment on the request URL is a question about ONE section. Answer it
    // directly, and be explicit when we cannot.
    let fragmentNote = '';
    let body = markdown;
    if (hash) {
      const f = classifyFragment(anchorMatch, markdown, hash, truncated);
      if (f.kind === 'found') {
        body = f.section;
        const caseNote = f.exactCase ? '' : ' (matched case-insensitively — the served id differs in case from the fragment)';
        fragmentNote = `\n\n[Showing the "#${hash}" section only${caseNote}. Refetch without the fragment for the whole page.]`;
      } else if (f.kind === 'dropped') {
        const caseNote = f.exactCase ? '' : ' (case-insensitive match)';
        fragmentNote = `\n\n[The page has an anchor named "#${hash}"${caseNote}, but article extraction did not keep that section. The full text above is what was extracted.]`;
      } else {
        // Important finding (2026-08-06 review): this used to be a flat "the
        // HTML contains no anchor named X" regardless of whether the body was
        // truncated at the 5MB cap — a categorical claim about bytes that, when
        // truncated, were never actually read. Scope the wording to what was
        // examined.
        fragmentNote = f.bodyTruncated
          ? `\n\n[No anchor named "#${hash}" was found in the portion of this page that was fetched. The body was truncated at 5MB, so a later part of the page may still contain it.]`
          : `\n\n[The HTML served for this URL contains no anchor named "#${hash}".]`;
      }
    }
    const resultText = `${header}${title ? `\nTitle: ${title}` : ''}\n\n${body}${fragmentNote}${jsNote}`;
    // Fix (BLOCKER B1, round 5, 2026-08-06 review): this used to declare
    // `bounds: { shown: MAX_BODY_BYTES, total: null, unit: 'bytes' }` whenever
    // the network fetch hit the 5MB cap — but `resultText` here is the
    // EXTRACTED MARKDOWN, not the raw fetched bytes, so that claim collapsed
    // "we fetched 5MB of HTML" into "we showed you 5MB of content". Measured
    // on a 6,000,501-byte page whose article was one short paragraph: the
    // tool returned 555 characters of markdown while `bounds` claimed
    // `shown: 5242880`, and composeNotice rendered "showing 5242880 of at
    // least 5242880 bytes" — telling the model it had seen (at minimum) the
    // whole page when 758KB was never fetched and ~5.24MB was never shown.
    // `shown` now measures what's actually in `resultText` (chars), which is
    // the honest quantity; `total` stays `null` because the true size is
    // still genuinely unknown (Readability ran on a body that was itself cut
    // short, so there is no measured "how much more" to report). The 5MB
    // network fact is real information and stays disclosed — as plain prose
    // (bodyCapNote), the same pattern the too-complex-extraction branch above
    // already uses for the identical fact, not folded back into a number
    // that overstates coverage.
    const bodyCapNote = truncated
      ? '\n\n[The response body itself was cut off at the 5MB fetch cap before extraction ran — the live page may be larger than what was extracted.]'
      : '';
    return {
      text: `${resultText}${bodyCapNote}`,
      bounds: truncated
        ? { shown: resultText.length, total: null, unit: 'chars' as const, moreHint: 'fetch a more specific URL, or a narrower section of the page' }
        : undefined,
    };
  },
});
