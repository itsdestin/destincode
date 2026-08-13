// The LLM judge: scores a finished run's WRITTEN ANSWER against a case's
// rubric — the "did this read well?" half of an eval, which no assertion can
// measure. The mechanical checks (assertions.ts) own everything with an exact
// answer; this file owns everything that needs a reader.
//
// WHY the quote rule exists, and why it lives in CODE:
//   Destin is a non-developer making a real decision from these numbers, and a
//   score he cannot spot-check is a number he has to take on faith. So every
//   grade must carry a quote from the answer it is grading, and a grade whose
//   quote is not actually in that answer is DISCARDED, not warned about. The
//   prompt asks for quotes too, but asking is not enforcement — the same
//   falsifiability discipline test-engine/conversation-triage.mjs applies to
//   its incident taxonomy, moved from the prompt into the checker.
//
// WHY a contradiction only WARNS:
//   When the judge asserts something the event stream can settle ("it never
//   searched the code" against a passing called-tool:Grep check), averaging that into
//   a score would launder a grader error into the result. run-facts.ts already
//   does this for a model's claims about its own run; a judge gets the same
//   treatment — the warning prints next to the grade and the score is left
//   exactly as the judge gave it.
//
// WHY nothing here can fail a run:
//   Grading happens last, after real money has been spent. Every failure path
//   below returns `unavailable` with the provider's REAL message and leaves the
//   run's mechanical checks and written answer untouched. judgeRun never
//   throws.
import { generateText } from 'ai';
import type { ModelFactory } from '../harness-session';
import type { CaseRun, CheckResult, RubricItem } from './case-types';
import { claimedTools } from './run-facts';

/** Top of the scoring scale the prompt asks for. A score outside 0..this is
 *  treated as malformed rather than clamped: a judge that returns 9/5 has not
 *  understood the scale, and silently rescaling its answer would hide that. */
export const JUDGE_SCALE_MAX = 5;

/** Shortest quote that can still be evidence. "a lock" appears in almost any
 *  answer about locks and proves nothing about whether the judge read it; the
 *  floor is what stops a grader from satisfying the quote rule with filler. */
export const MIN_QUOTE_CHARS = 12;

/** How many pieces one quote may be stitched from with "…". WHY a cap at all:
 *  each segment is verified independently, so an UNCAPPED elision lets a judge
 *  assemble a sentence the answer never made out of fragments taken from
 *  opposite ends of a long answer — every piece verbatim, the claim invented.
 *  The ` … ` join marks the seams for a reader, which is most of the defence;
 *  the cap closes the assembly loophole itself. Three allows the ordinary
 *  "opening … middle … closing" quote and stops the collage. */
export const MAX_QUOTE_SEGMENTS = 3;

/** Wall-clock ceiling for the judge call. Grading is the last step of an
 *  already-paid run — an unbounded await here would hang the whole matrix. */
const JUDGE_TIMEOUT_MS = 120_000;

/** How much of the answer the judge is shown. Quote verification still runs
 *  against the FULL answer, so truncation can only ever cost a quote, never
 *  admit a fake one. */
const MAX_ANSWER_CHARS = 60_000;

/** Tool calls listed in the prompt, oldest first. */
const MAX_TOOL_CALLS_SHOWN = 60;

/** How much of an unparseable judge reply to quote back in `unavailable`. */
const RAW_EXCERPT_CHARS = 300;

export interface Grade {
  id: string;
  score: number;
  /** Verified: this exact text was found in the run's answer. It is the SOURCE
   *  substring, not the judge's transcription of it, so Ctrl-F finds it. */
  quote: string;
  /** The judge's own sentence about why. WHY it is part of the shape: it is the
   *  only judge-authored prose available, and it is what the contradiction scan
   *  reads. Optional — a judge that omits it still produces usable grades, it
   *  just can't be caught contradicting the event stream. */
  reason?: string;
}

export interface JudgeResult {
  grades: Grade[];
  /** Set only when grading did not happen. Carries the provider's real message. */
  unavailable?: string;
  /** Rendered ABOVE the grades by the report. Never folded into a score. */
  warnings: string[];
  /** How many grade rows the judge returned (before verification). 0 whenever
   *  `unavailable` is set — nothing was parsed. */
  attempted: number;
  /** How many of those survived id/score/quote verification: `grades.length`.
   *
   *  WHY these two counts are part of the result rather than left to be counted
   *  downstream: `grades: []` alone is ambiguous. "The judge skipped one item"
   *  and "the judge returned five grades and all five failed quote
   *  verification" produce the same empty array and the same undefined
   *  `unavailable`, so a report keying on `unavailable` renders an empty column
   *  that reads as "no issues found". attempted/kept is the discard rate — the
   *  number that says whether the quote rule is working or whether the prompt
   *  needs work — and this is the only file that can compute it. */
  kept: number;
}

// --- quote verification ------------------------------------------------------

// Characters a model routinely "improves" when it copies text: curly quotes,
// en/em dashes, non-breaking spaces. Normalizing these is not a loophole — the
// glyph differs, the claim doesn't, and leaving them unnormalized would drop
// honest quotes and teach a reader to ignore the warning.
const CHAR_FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '‟': '"', '″': '"',
  '–': '-', '—': '-', '−': '-',
  ' ': ' ',
};

// An elision the judge inserted to skip the middle of a long sentence.
const ELISION = /\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*/g;

interface Normalized {
  text: string;
  /** map[i] = index in the ORIGINAL string of the character that produced
   *  text[i]. Lets a match be reported back as real source text. */
  map: number[];
}

/** Fold case, fold the smart-punctuation classes above, collapse every run of
 *  whitespace to one space — and remember where each surviving character came
 *  from. WHY whitespace collapse: the answer is hard-wrapped, so a model
 *  quoting across a line break returns a space where the source has a newline.
 *  That is the same text. */
function normalize(src: string): Normalized {
  let text = '';
  const map: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const folded = CHAR_FOLD[raw] ?? raw;
    if (/\s/.test(folded)) {
      // One space per run; the run's FIRST character is the one we point at.
      if (!inWhitespace) { text += ' '; map.push(i); inWhitespace = true; }
      continue;
    }
    inWhitespace = false;
    const lower = folded.toLowerCase();
    // Guard the 1:1 invariant the map depends on: a few code points (e.g.
    // U+0130) lowercase to TWO characters, which would desynchronize map from
    // text. Those stay as-is; they are not the characters models mangle.
    text += lower.length === 1 ? lower : folded;
    map.push(i);
  }
  return { text, map };
}

type QuoteVerdict =
  | { ok: true; source: string }
  | { ok: false; why: 'no-quote' | 'not-found' }
  // `segments` / `shortest` travel with the failure so the warning can describe
  // what actually failed. WHY: a quote is split on "…" before it is measured,
  // so "the quote is under 12 characters" is FALSE for a 30-character quote
  // whose own text contains "…" — the answer said "wait for it… then retry" and
  // the judge copied it perfectly. A message that names the wrong thing sends
  // the reader looking for a defect that is not there
  // (docs/error-message-standards.md).
  | { ok: false; why: 'too-short'; segments: number; shortest: number }
  | { ok: false; why: 'too-many-segments'; segments: number };

/** The falsifiability mechanism. A quote passes only if every one of its
 *  segments (split on elisions) appears in the answer, in order, each at least
 *  MIN_QUOTE_CHARS long, and there are at most MAX_QUOTE_SEGMENTS of them.
 *  Returns the matched SOURCE text so what gets printed is the answer's own
 *  words. */
function verifyQuote(quote: unknown, answer: string): QuoteVerdict {
  if (typeof quote !== 'string' || !quote.trim()) return { ok: false, why: 'no-quote' };

  // Strip wrapping quotation marks the judge may have added around its excerpt.
  const stripped = quote.trim().replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '');
  const needle = normalize(stripped);
  const segments = needle.text.split(ELISION).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return { ok: false, why: 'no-quote' };
  // Cap first: a collage of eight fragments is a structural problem with the
  // quote, and reporting the shortest of them would describe a symptom.
  if (segments.length > MAX_QUOTE_SEGMENTS) {
    return { ok: false, why: 'too-many-segments', segments: segments.length };
  }
  // Reported as a LENGTH, not as the offending text: `segments` come out of
  // normalize(), which case-folds, so printing one back would hand the reader a
  // string that does not match the answer they are about to Ctrl-F.
  const shortest = Math.min(...segments.map((s) => s.length));
  if (shortest < MIN_QUOTE_CHARS) {
    return { ok: false, why: 'too-short', segments: segments.length, shortest };
  }

  const hay = normalize(answer);
  const found: string[] = [];
  let from = 0;
  for (const segment of segments) {
    const at = hay.text.indexOf(segment, from);
    if (at === -1) return { ok: false, why: 'not-found' };
    const start = hay.map[at];
    const end = hay.map[at + segment.length - 1] + 1;
    found.push(answer.slice(start, end));
    from = at + segment.length;   // in order: the next segment must follow this one
  }
  return { ok: true, source: found.join(' … ') };
}

/** Why a quote was rejected, in words that describe what was actually
 *  measured. WHY it is worth a function: the too-short branch is measured on
 *  SEGMENTS, not on the quote, and saying "the quote is under 12 characters"
 *  about a 30-character quote containing a literal "…" is a message that
 *  describes the wrong thing — the error-message standard again. */
function quoteFailure(verdict: Extract<QuoteVerdict, { ok: false }>): string {
  switch (verdict.why) {
    case 'no-quote':
      return 'it carried no quote. A grade with no checkable quote is not evidence.';
    case 'not-found':
      return 'its quote was not found verbatim in the answer. A grade with no checkable quote is not evidence.';
    case 'too-many-segments':
      return `its quote is stitched from ${verdict.segments} separate fragments, over the limit of ${MAX_QUOTE_SEGMENTS}. ` +
        'Each fragment may be verbatim and the sentence they add up to still be one the answer never made.';
    case 'too-short':
      return verdict.segments > 1
        ? `its quote splits on "…" into ${verdict.segments} segments and the shortest is only ${verdict.shortest} ` +
          `characters, too short to verify — every segment must be at least ${MIN_QUOTE_CHARS}. If that "…" is the ` +
          'answer\'s own text and not an elision, re-quote an unbroken stretch around it.'
        : `its quote is only ${verdict.shortest} characters, too short to verify (${MIN_QUOTE_CHARS} is the minimum). ` +
          'A grade with no checkable quote is not evidence.';
  }
}

// --- contradiction detection -------------------------------------------------

// A clause that DENIES something. Only a denial can contradict a passing check;
// "it ran Grep" agreeing with a passing called-tool:Grep check is not news.
const DENIAL = /\b(never|didn'?t|did ?n[o']t|did not|does not|doesn'?t|no evidence|no sign|failed to|at no point|nothing (?:shows|indicates|suggests)|without (?:ever )?(?:search|read|run|look|using|calling))\b/i;

// Phrases where a synonym verb is NOT talking about a tool. WHY a strip pass
// rather than more lookaheads inside each pattern: these are idioms, and one
// list of them is auditable where six patterns each carrying their own
// exceptions is not. Both entries are demonstrated false positives, not
// guesses — "It does not read like someone who understood the code" tripped
// Read, and "It never ran into the real problem" tripped Bash. Removing the
// idiom from the fragment before the tool scan leaves the denial intact (the
// denial is tested against the untouched text), so this can only ever suppress
// a warning about a verb that was never about a tool.
const NON_TOOL_IDIOMS = /\b(?:reads?|reading)\s+(?:like|as if|as though)\b|\b(?:ran|runs?|running)\s+(?:into|across|out of|up against|counter to)\b/gi;

// Everyday words for what each tool does. WHY this exists: a judge writes "it
// never searched the code", not "it never called Grep", and the tool-name-only
// match would miss every real contradiction. Heuristic by construction — it can
// only ever produce a WARNING, never a score change, so a false positive costs
// a sentence of reading and a false negative costs nothing that was there before.
const TOOL_SYNONYMS: Record<string, RegExp> = {
  Grep: /\b(grep|search(?:ed|ing|es)?|scan(?:ned|ning)?)\b/i,
  Glob: /\b(glob|find files|list(?:ed)? files|file search)\b/i,
  Read: /\b(read|open(?:ed)?|view(?:ed)?|inspect(?:ed)?|look(?:ed)? at)\b/i,
  Bash: /\b(bash|shell|ran|run|execut(?:e|ed))\b/i,
  Edit: /\b(edit(?:ed)?|modif(?:y|ied)|chang(?:e|ed))\b/i,
  Write: /\b(wrote|writ(?:e|ten)|creat(?:e|ed))\b/i,
};

/** Tools a fragment is talking about: named outright (reusing run-facts'
 *  whole-word matcher so the tool roster stays single-sourced) or described. */
function toolsMentioned(fragment: string): string[] {
  const cleaned = fragment.replace(NON_TOOL_IDIOMS, ' ');
  const named = claimedTools(cleaned);
  const described = Object.keys(TOOL_SYNONYMS).filter((t) => TOOL_SYNONYMS[t].test(cleaned));
  return [...new Set([...named, ...described])];
}

/** A check id from assertions.ts's `calledTool(name)`, which is the ONLY check
 *  shape that is evidence a tool was used. */
const CALLED_TOOL_ID = /^called-tool:(.+)$/;

/** Which tool each PASSING check is evidence for, read from the check ID ONLY.
 *
 *  WHY the `detail` is deliberately not scanned: `CheckResult.detail` is an
 *  untyped human string, so any check whose prose happens to contain a tool
 *  name registers that tool as proven — including a check asserting a tool's
 *  ABSENCE. "The model made no Write or Edit calls", passing, would prove Write
 *  and Edit, and a judge reason "it never wrote any code" would then print
 *  "but the mechanical check PASSED" — a claim that is exactly backwards, shown
 *  to a non-developer as a mechanical fact. (`called-tool:`'s own passing
 *  detail also lists every tool attempted, which would prove all of them off
 *  one check.) A check id is a controlled vocabulary; a detail string is prose. */
function provenTools(checks: CheckResult[]): Map<string, CheckResult> {
  const proven = new Map<string, CheckResult>();
  for (const check of checks) {
    if (check.state !== 'passed') continue;
    const tool = CALLED_TOOL_ID.exec(check.id)?.[1]?.trim();
    if (!tool || proven.has(tool)) continue;
    proven.set(tool, check);
  }
  return proven;
}

/** Warnings for judge claims the event stream already settles. Reads ONLY
 *  judge-authored prose (`reason`) — the `quote` is the RUN's words, and a run
 *  honestly admitting "I never searched" must not be scored as the judge
 *  contradicting anything.
 *
 *  WHY the denial and the tool word must share a COMMA-delimited fragment:
 *  splitting only on `.;!?\n` makes a comma-joined sentence one clause, so the
 *  denial need have no relationship to the tool word at all — "It never
 *  explains its reasoning, though it did read the config loader" trips `never`
 *  + `read` and warns that the judge denied a Read the judge never denied. The
 *  sentence is still what gets PRINTED, so the reader sees full context; only
 *  the matching is narrowed. */
function contradictionWarnings(grades: RawGrade[], checks: CheckResult[]): string[] {
  const proven = provenTools(checks);
  if (!proven.size) return [];
  const out: string[] = [];
  for (const grade of grades) {
    if (typeof grade.reason !== 'string') continue;
    for (const sentence of grade.reason.split(/[.;!?\n]+/)) {
      if (!DENIAL.test(sentence)) continue;   // cheap pre-filter for the common case
      for (const fragment of sentence.split(',')) {
        if (!DENIAL.test(fragment)) continue;
        for (const tool of toolsMentioned(fragment)) {
          const check = proven.get(tool);
          if (!check) continue;
          out.push(
            `⚠️ Contradiction — the judge's note on "${grade.id}" says "${sentence.trim()}", ` +
            `but the mechanical check ${check.id} PASSED (${check.detail}). The score below is ` +
            `printed exactly as the judge gave it; decide which one you believe.`,
          );
        }
      }
    }
  }
  return [...new Set(out)];
}

// --- prompt ------------------------------------------------------------------

/** `Read {"file_path":"config.ts"}`, one per line — enough for the judge to see
 *  whether the answer's claims about its own process line up. */
function toolCallList(run: CaseRun): string {
  const calls = run.events
    .filter((e) => e.type === 'tool-use')
    .map((e) => {
      const input = JSON.stringify(e.data.toolInput ?? {});
      return `${e.data.toolName ?? '?'} ${input.length > 120 ? `${input.slice(0, 120)}…` : input}`;
    });
  if (!calls.length) return '(no tool calls)';
  const shown = calls.slice(0, MAX_TOOL_CALLS_SHOWN);
  const rest = calls.length - shown.length;
  return shown.join('\n') + (rest > 0 ? `\n(+${rest} more tool calls)` : '');
}

/** WHY the model id is deliberately absent: a judge told "this was written by
 *  Claude Opus 5" is grading a brand as much as an answer, and this tool exists
 *  to compare models against each other. The judge sees the work, not the
 *  author. */
function buildPrompt(run: CaseRun, rubric: RubricItem[]): string {
  const answer = run.review.length > MAX_ANSWER_CHARS
    ? `${run.review.slice(0, MAX_ANSWER_CHARS)}\n[…answer truncated for grading…]`
    : run.review;
  return [
    'You are grading one AI assistant\'s written answer against a rubric.',
    '',
    'RUBRIC — score each item from 0 to ' + JUDGE_SCALE_MAX + ':',
    ...rubric.map((item) => `- ${item.id}: ${item.ask}`),
    '',
    'TOOL CALLS THE ASSISTANT MADE (in order):',
    toolCallList(run),
    '',
    'THE ANSWER:',
    '"""',
    answer,
    '"""',
    '',
    'Reply with STRICT JSON and nothing else: an array of objects, one per rubric',
    'item, each {"id": "<rubric id>", "score": <0-' + JUDGE_SCALE_MAX + '>, "quote": "<exact text',
    'copied from THE ANSWER>", "reason": "<one sentence>"}.',
    '',
    'The quote is checked character by character against the answer by a program.',
    'Copy it, do not paraphrase or reconstruct it. A grade whose quote is not found',
    'in the answer is discarded, and the rubric item ends up with no score at all.',
    'Use "…" to elide the middle of a long quote; each piece is still checked, and a',
    `quote may be split into at most ${MAX_QUOTE_SEGMENTS} pieces. Each piece must be at least`,
    `${MIN_QUOTE_CHARS} characters, so if the answer's own text contains "…", quote an unbroken`,
    'stretch around it instead.',
  ].join('\n');
}

// --- provider errors ---------------------------------------------------------

/** The provider's actual words. WHY this is not `String(err)`: a provider
 *  rejecting with a plain object renders as "[object Object]" — a real defect
 *  this harness has already shipped once. Never a guessed cause
 *  (docs/error-message-standards.md). */
function realMessage(err: unknown): string {
  if (err instanceof Error) {
    const body = (err as { responseBody?: unknown }).responseBody;
    const extra = typeof body === 'string' && body.trim() ? ` — ${body.trim().slice(0, 500)}` : '';
    return `${err.message || err.name || 'Error'}${extra}`;
  }
  if (typeof err === 'string') return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return json;
  } catch { /* circular or otherwise unserializable — fall through */ }
  return String(err);
}

// --- parsing -----------------------------------------------------------------

interface RawGrade { id?: unknown; score?: unknown; quote?: unknown; reason?: unknown }

/** Pull a JSON array of grades out of whatever the judge said: a bare array, a
 *  {"grades": [...]} wrapper, or either wrapped in a ``` fence or prose. Returns
 *  null if no array of objects can be read — the caller turns that into
 *  `unavailable`.
 *
 *  WHY no fence-stripping step: slicing from the first bracket to the last
 *  already steps over ``` markers, which sit outside the JSON. A strip pass was
 *  written here first; deleting it changed no test result (Task 10 mutation
 *  M17), so it was code that only looked like it was doing work. */
function parseGrades(text: string): RawGrade[] | null {
  const body = text.trim();
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { continue; }
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { grades?: unknown }).grades))
        ? (parsed as { grades: unknown[] }).grades
        : null;
    if (rows && rows.every((r) => r && typeof r === 'object')) return rows as RawGrade[];
  }
  return null;
}

// --- the judge ---------------------------------------------------------------

/** Grade one run against its rubric. Never throws: a judge that errors, times
 *  out, returns nothing, or returns junk yields `{ grades: [], unavailable }`,
 *  and the caller keeps the run's mechanical checks and written answer.
 *
 *  `judge: null` means "not grading" and is a clean no-op — no call, no error,
 *  no warnings. */
export async function judgeRun(
  run: CaseRun,
  rubric: RubricItem[],
  // Inline rather than a named exported type: knip flags an exported interface
  // nothing else imports, and the brief pins this literal shape.
  judge: { modelId: string; factory: ModelFactory } | null,
  checks: CheckResult[],
): Promise<JudgeResult> {
  if (!judge || rubric.length === 0) return { grades: [], warnings: [], attempted: 0, kept: 0 };

  const warnings: string[] = [];
  // Flagged, not refused: models favour their own output, and the reader needs
  // to know which grades to discount. Case/whitespace-insensitive because a
  // roster and a judge field are typed by hand, and everything after the first
  // `:` is dropped because OpenRouter's `:free` / `:beta` / `:nitro` variant
  // suffixes select a serving tier, not a different model — `x/y` judging
  // `x/y:beta` is the same weights grading their own output and must flag.
  const baseModel = (id: string) => id.trim().toLowerCase().split(':')[0];
  const same = baseModel(judge.modelId) === baseModel(run.modelId);
  if (same) {
    warnings.push(
      `⚠️ Self-grading: the judge (${judge.modelId}) is the same model that wrote this answer. ` +
      `Models favour their own output — weigh these grades accordingly.`,
    );
  }

  // Built OUTSIDE the judge-call try, and with its own actor. WHY: inside that
  // try, a TypeError thrown by our own prompt builder surfaced as "The judge
  // model failed: …" — accurate about the text, wrong about who failed, and it
  // would send a reader to the provider's status page over a bug in this file.
  // Still caught, because judgeRun must never throw.
  let prompt: string;
  try {
    prompt = buildPrompt(run, rubric);
  } catch (err) {
    return {
      grades: [], attempted: 0, kept: 0,
      unavailable: `Could not build the judge prompt for this run — no judge call was made, so nothing was spent. Error: ${realMessage(err)}`,
      warnings,
    };
  }

  // The judge call, bounded. WHY an explicit controller rather than
  // AbortSignal.timeout: `aborted` below is then a FACT this code can assert
  // (we fired it), not an inference from an error name we would be guessing at.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), JUDGE_TIMEOUT_MS);
  let text: string;
  try {
    const model = await judge.factory(
      // The binding is informational: judge factories are model-pinned
      // (openrouter-factory.ts ignores it), and matrix.ts documents `judge` as
      // an OpenRouter model id.
      { providerId: 'openrouter', modelId: judge.modelId },
    );
    const result = await generateText({ model, prompt, abortSignal: abort.signal });
    text = result.text ?? '';
  } catch (err) {
    const message = realMessage(err);
    return {
      grades: [], attempted: 0, kept: 0,
      unavailable: abort.signal.aborted
        ? `The judge did not answer within ${JUDGE_TIMEOUT_MS} ms and was aborted. Provider error: ${message}`
        : `The judge model failed: ${message}`,
      warnings,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!text.trim()) {
    return { grades: [], attempted: 0, kept: 0, unavailable: 'The judge returned no text.', warnings };
  }

  const raw = parseGrades(text);
  if (!raw) {
    const excerpt = text.length > RAW_EXCERPT_CHARS
      ? `${text.slice(0, RAW_EXCERPT_CHARS)}… (truncated, ${text.length} chars total)`
      : text;
    return {
      grades: [], attempted: 0, kept: 0,
      unavailable: `The judge did not return JSON grades. What it returned: ${excerpt}`,
      warnings,
    };
  }

  // Contradictions are scanned across ALL grades the judge returned, before the
  // quote filter — an unquoted grade still tells you the grader disagrees with
  // the event stream, which is the thing worth surfacing.
  warnings.push(...contradictionWarnings(raw, checks));

  const known = new Set(rubric.map((item) => item.id));
  const grades: Grade[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || !known.has(id)) {
      warnings.push(`Dropped a grade for "${id || '(no id)'}": not a rubric item in this case.`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`Dropped a second grade for "${id}": the judge graded it twice.`);
      continue;
    }
    // NOT `seen.add(id)` here. WHY: marking the id seen before it has passed
    // score and quote validation means a malformed grade CLAIMS the id, and a
    // valid grade for the same id later in the array is then dropped as "the
    // judge graded it twice" — a warning that names the wrong problem and costs
    // a usable grade. The id is claimed only once one is accepted, below.

    const score = typeof row.score === 'number' ? row.score : NaN;
    if (!Number.isFinite(score) || score < 0 || score > JUDGE_SCALE_MAX) {
      warnings.push(`Dropped "${id}": score ${JSON.stringify(row.score)} is not a number from 0 to ${JUDGE_SCALE_MAX}.`);
      continue;
    }

    // The haystack is `run.review` and NOTHING else. The rubric text and the
    // tool-call list are in the prompt the judge was shown, so widening this
    // argument would let a judge satisfy the quote rule by copying back the
    // question instead of the answer. Two tests pin that rejection.
    const verdict = verifyQuote(row.quote, run.review);
    if (!verdict.ok) {
      warnings.push(`Dropped "${id}" (score ${score}): ${quoteFailure(verdict)}`);
      continue;
    }

    seen.add(id);
    grades.push({
      id, score, quote: verdict.source,
      ...(typeof row.reason === 'string' && row.reason.trim() ? { reason: row.reason.trim() } : {}),
    });
  }

  for (const item of rubric) {
    if (!grades.some((grade) => grade.id === item.id)) {
      warnings.push(`No usable grade for "${item.id}".`);
    }
  }

  // The all-discarded case. WHY it gets its own warning at the TOP of the list
  // rather than being left to the per-grade lines below it: each discard is
  // already named, but a reader (and a report) sees `grades: []` with no
  // `unavailable`, which is the same shape as "the judge skipped one item" —
  // and an empty grade column reads as "no issues found" when it actually means
  // "the judge graded everything and none of it could be verified". That is a
  // signal about the JUDGE, not about the run being graded.
  if (raw.length > 0 && grades.length === 0) {
    warnings.unshift(
      `⚠️ This run is effectively UNGRADED: the judge returned ${raw.length} ` +
      `grade${raw.length === 1 ? '' : 's'} and all ${raw.length} of them were discarded — 0 kept. ` +
      'An empty grade list here means nothing survived verification, NOT that nothing was wrong ' +
      'with the answer. The reason for each discard is listed below.',
    );
  }

  return { grades, warnings, attempted: raw.length, kept: grades.length };
}
