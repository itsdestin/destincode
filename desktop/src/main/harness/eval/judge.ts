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
//   searched the code" against a passing calledTool:Grep), averaging that into
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
  | { ok: false; why: 'no-quote' | 'too-short' | 'not-found' };

/** The falsifiability mechanism. A quote passes only if every one of its
 *  segments (split on elisions) appears in the answer, in order, each at least
 *  MIN_QUOTE_CHARS long. Returns the matched SOURCE text so what gets printed
 *  is the answer's own words. */
function verifyQuote(quote: unknown, answer: string): QuoteVerdict {
  if (typeof quote !== 'string' || !quote.trim()) return { ok: false, why: 'no-quote' };

  // Strip wrapping quotation marks the judge may have added around its excerpt.
  const stripped = quote.trim().replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '');
  const needle = normalize(stripped);
  const segments = needle.text.split(ELISION).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return { ok: false, why: 'no-quote' };
  if (segments.some((s) => s.length < MIN_QUOTE_CHARS)) return { ok: false, why: 'too-short' };

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

// --- contradiction detection -------------------------------------------------

// A clause that DENIES something. Only a denial can contradict a passing check;
// "it ran Grep" agreeing with a passing calledTool:Grep is not news.
const DENIAL = /\b(never|didn'?t|did ?n[o']t|did not|does not|doesn'?t|no evidence|no sign|failed to|at no point|nothing (?:shows|indicates|suggests)|without (?:ever )?(?:search|read|run|look|using|calling))\b/i;

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

/** Tools a clause is talking about: named outright (reusing run-facts'
 *  whole-word matcher so the tool roster stays single-sourced) or described. */
function toolsMentioned(clause: string): string[] {
  const named = claimedTools(clause);
  const described = Object.keys(TOOL_SYNONYMS).filter((t) => TOOL_SYNONYMS[t].test(clause));
  return [...new Set([...named, ...described])];
}

/** Which tool each PASSING check is evidence for. A check id like
 *  `calledTool:Grep` names its tool; the detail is searched too, so a check
 *  that spells the tool only in its detail still counts. */
function provenTools(checks: CheckResult[]): Map<string, CheckResult> {
  const proven = new Map<string, CheckResult>();
  for (const check of checks) {
    if (check.state !== 'passed') continue;
    for (const tool of claimedTools(`${check.id} ${check.detail ?? ''}`)) {
      if (!proven.has(tool)) proven.set(tool, check);
    }
  }
  return proven;
}

/** Warnings for judge claims the event stream already settles. Reads ONLY
 *  judge-authored prose (`reason`) — the `quote` is the RUN's words, and a run
 *  honestly admitting "I never searched" must not be scored as the judge
 *  contradicting anything. */
function contradictionWarnings(grades: RawGrade[], checks: CheckResult[]): string[] {
  const proven = provenTools(checks);
  if (!proven.size) return [];
  const out: string[] = [];
  for (const grade of grades) {
    if (typeof grade.reason !== 'string') continue;
    for (const clause of grade.reason.split(/[.;!?\n]+/)) {
      if (!DENIAL.test(clause)) continue;
      for (const tool of toolsMentioned(clause)) {
        const check = proven.get(tool);
        if (!check) continue;
        out.push(
          `⚠️ Contradiction — the judge's note on "${grade.id}" says "${clause.trim()}", ` +
          `but the mechanical check ${check.id} PASSED (${check.detail}). The score below is ` +
          `printed exactly as the judge gave it; decide which one you believe.`,
        );
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
    'Use "…" to elide the middle of a long quote; each half is still checked.',
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
  if (!judge || rubric.length === 0) return { grades: [], warnings: [] };

  const warnings: string[] = [];
  // Flagged, not refused: models favour their own output, and the reader needs
  // to know which grades to discount. Case/whitespace-insensitive because a
  // roster and a judge field are typed by hand.
  const same = judge.modelId.trim().toLowerCase() === run.modelId.trim().toLowerCase();
  if (same) {
    warnings.push(
      `⚠️ Self-grading: the judge (${judge.modelId}) is the same model that wrote this answer. ` +
      `Models favour their own output — weigh these grades accordingly.`,
    );
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
    const result = await generateText({ model, prompt: buildPrompt(run, rubric), abortSignal: abort.signal });
    text = result.text ?? '';
  } catch (err) {
    const message = realMessage(err);
    return {
      grades: [],
      unavailable: abort.signal.aborted
        ? `The judge did not answer within ${JUDGE_TIMEOUT_MS} ms and was aborted. Provider error: ${message}`
        : `The judge model failed: ${message}`,
      warnings,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!text.trim()) {
    return { grades: [], unavailable: 'The judge returned no text.', warnings };
  }

  const raw = parseGrades(text);
  if (!raw) {
    const excerpt = text.length > RAW_EXCERPT_CHARS
      ? `${text.slice(0, RAW_EXCERPT_CHARS)}… (truncated, ${text.length} chars total)`
      : text;
    return {
      grades: [],
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
    seen.add(id);

    const score = typeof row.score === 'number' ? row.score : NaN;
    if (!Number.isFinite(score) || score < 0 || score > JUDGE_SCALE_MAX) {
      warnings.push(`Dropped "${id}": score ${JSON.stringify(row.score)} is not a number from 0 to ${JUDGE_SCALE_MAX}.`);
      continue;
    }

    const verdict = verifyQuote(row.quote, run.review);
    if (!verdict.ok) {
      const why = verdict.why === 'no-quote'
        ? 'it carried no quote'
        : verdict.why === 'too-short'
          ? `its quote is under ${MIN_QUOTE_CHARS} characters, too short to verify`
          : 'its quote was not found verbatim in the answer';
      warnings.push(`Dropped "${id}" (score ${score}): ${why}. A grade with no checkable quote is not evidence.`);
      continue;
    }

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

  return { grades, warnings };
}
