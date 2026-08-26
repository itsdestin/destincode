#!/usr/bin/env node
// conversation-triage.mjs — cheap two-stage failure screening over past conversations.
//
// Purpose (2026-08-11 super-agent roadmap, step 1): rank the conversation corpus by
// "something went wrong here" signals so human error analysis reads the right 50
// sessions instead of a random 50. This is a TRIAGE SUGGESTER, not the taxonomy
// owner — Destin finalizes categories (Hamel Husain's benevolent-dictator rule).
//
// Stage 1 (scan)   — FREE, deterministic. Parses every session, scores lexical +
//                    structural failure signals, writes a ranked report.
// Stage 2 (triage) — PAID, capped. Sends flagged excerpt windows to a cheap
//                    OpenRouter model to classify candidate failures as JSON.
//
// Sources parsed:
//   native  ~/.youcoded/sessions/<slug>/<id>.jsonl        (TranscriptEvent JSONL, line 1 = header)
//   claude  ~/YouCoded/Personal/Conversations/claude/transcripts/**/*.jsonl  (Claude Code JSONL)
//
// Usage:
//   node test-engine/conversation-triage.mjs scan                      # free, whole corpus
//   node test-engine/conversation-triage.mjs scan --lanes native       # native only
//   node test-engine/conversation-triage.mjs triage --top 40 --dry-run # plan + token estimate, no spend
//   OPENROUTER_API_KEY=... node test-engine/conversation-triage.mjs triage --top 40
//   node test-engine/conversation-triage.mjs both --top 40             # scan then triage
//
// Flags: --lanes native,claude   --limit N (scan file cap)   --since YYYY-MM-DD
//        --top N (triage sessions, default 40)   --model <openrouter id>
//        --max-calls N (hard spend cap, default = --top)   --concurrency N (default 4)
//        --out <dir>   --stats-only (scan prints counts, no snippets)   --dry-run
//
// Model default: deepseek/deepseek-v4-flash-0731 (the roster's cheap tier as of
// 2026-08-11). VERIFY current pricing on openrouter.ai before big runs —
// DeepSeek pre-announced a price increase (assistant-workspace KB, model-landscape).
//
// Output dir (git-ignored): docs/active/investigations/conversation-triage-runs/<UTC-date>/
//   scan.jsonl / scan-report.md / findings.jsonl / triage-report.md
// Reports contain conversation excerpts — they stay on this machine.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
if (!['scan', 'triage', 'both'].includes(cmd)) {
  console.error('usage: conversation-triage.mjs <scan|triage|both> [flags] (see file header)');
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const LANES = String(flag('lanes', 'native,claude')).split(',');
const LIMIT = Number(flag('limit', Infinity));
const SINCE = flag('since', null) ? Date.parse(flag('since', null)) : 0;
const TOP = Number(flag('top', 40));
const MODEL = String(flag('model', DEFAULT_MODEL));
const SYNTH_MODEL = String(flag('synth-model', MODEL));
const MAX_CALLS = Number(flag('max-calls', TOP));
const CONCURRENCY = Number(flag('concurrency', 4));
const DRY = argv.includes('--dry-run');
const STATS_ONLY = argv.includes('--stats-only');
const OUT_DIR = String(flag('out',
  path.join(REPO_ROOT, 'docs/active/investigations/conversation-triage-runs',
    new Date().toISOString().slice(0, 10))));

// ---------- normalized event model ----------
// {kind: user|assistant|tool-call|tool-result|interrupt|compact|error, text, toolName, toolInput, isError, model}

function* jsonlLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* torn tail — skip, mirroring native-home.ts */ }
  }
}

function parseNative(file) {
  const events = []; let header = null;
  for (const obj of jsonlLines(file)) {
    if (!header && obj.harnessId !== undefined && obj.binding !== undefined) { header = obj; continue; }
    const d = obj.data || {};
    switch (obj.type) {
      case 'user-message':   events.push({ kind: 'user', text: d.text || '' }); break;
      case 'assistant-text': events.push({ kind: 'assistant', text: d.text || '' }); break;
      case 'tool-use':       events.push({ kind: 'tool-call', toolName: d.toolName, toolInput: d.toolInput }); break;
      case 'tool-result':    events.push({ kind: 'tool-result', toolName: d.toolName, text: d.toolResult || '', isError: !!d.isError }); break;
      case 'user-interrupt': events.push({ kind: 'interrupt' }); break;
      case 'compact-summary':events.push({ kind: 'compact', text: d.text || '' }); break;
      case 'session-error':  events.push({ kind: 'error', text: d.text || '' }); break;
      case 'turn-complete':  if (d.stopReason) events.push({ kind: 'turn-end', stopReason: d.stopReason, model: d.model }); break;
      default: break; // thinking/context-clear/etc — not triage signals per se
    }
  }
  const model = header?.binding?.modelId
    || events.findLast?.((e) => e.model)?.model || null;
  return { events, model, lane: 'native' };
}

function ccText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

function parseClaude(file) {
  const events = []; let model = null;
  for (const obj of jsonlLines(file)) {
    const msg = obj.message;
    if (!msg || !obj.type) continue;
    if (obj.type === 'assistant') {
      model = msg.model || model;
      const text = ccText(msg.content);
      if (text) events.push({ kind: 'assistant', text });
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'tool_use') events.push({ kind: 'tool-call', toolName: b.name, toolInput: b.input });
      }
    } else if (obj.type === 'user') {
      if (obj.isCompactSummary) { events.push({ kind: 'compact', text: ccText(msg.content) }); continue; }
      const text = ccText(msg.content);
      if (/\[Request interrupted by user/i.test(text)) { events.push({ kind: 'interrupt' }); continue; }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'tool_result') {
          events.push({ kind: 'tool-result', text: ccText(b.content) || String(b.content ?? ''), isError: !!b.is_error });
        }
      }
      if (text) events.push({ kind: 'user', text });
    }
  }
  return { events, model, lane: 'claude' };
}

// ---------- stage 1: signals ----------
const APOLOGY = /\b(sorry|apolog\w*|my (mistake|bad|error)|i was (wrong|mistaken)|i misread|i misunderstood)\b/i;
// Known Claude-isms: mid-stream self-corrections and backtracking.
const SELF_CORRECTION = /\b(i (need|have|want) to correct|let me correct|i must correct|i misspoke|on second thought|let me reconsider|scratch that|let me try (that )?again|i made an error|that was incorrect|upon (closer|further) (inspection|review|reflection)|wait[,—-] |i see the (issue|problem) now|actually[,—-] (the|that|it|i|this)|to clarify[,:] i)\b/i;
// Sycophancy tics — individually weak, but dense clusters mark sessions where the
// model is smoothing over friction instead of fixing it.
const SYCOPHANCY = /\b(you'?re absolutely right|you are absolutely right|(great|excellent|good) (question|catch|point)|fair point|you'?re right to (push|question|point|call))\b/i;
// Overclaim / completion language. Standalone it's weak; followed by user pushback
// it's a false-success fingerprint.
const OVERCLAIM = /\b(all tests pass|works now|(should|will) (now )?work|this fixes|everything is (now )?working|fully (working|functional|implemented)|production.?ready|all set|complete and working|perfect!|done!)\b/i;
// Approach-thrash: the model abandoning strategies mid-turn.
const APPROACH_THRASH = /\b(let me try a different approach|let'?s try (a different|another) (approach|way|method)|alternative approach|instead[,]? let('s| me))\b/i;
const REDIRECT = /\b(that'?s not what i|not what i (said|meant|asked)|i didn'?t (say|ask)|you didn'?t|why did you|wrong file|wrong (approach|direction)|bruh|wtf|undo (that|this)|revert (that|this)|stop\b|don'?t do that|as i said|i already (said|told)|again[.!?]?$)/i;
// User annoyance indicators — tone, not content.
const ANNOYANCE_WORDS = /\b(ugh|come on|seriously|ffs|istg|jesus|for the (second|third|\w+th) time|you keep|stop doing|listen[,.]|pay attention|read (what|the)|are you (kidding|serious))\b/i;
// "???" is annoyance in a short message; in a long one it's usually pasted code (?? operator).
const isAnnoyed = (t) => ANNOYANCE_WORDS.test(t) || (/\?{2,}/.test(t) && t.trim().length < 200);
// "Still broken": user reports the thing the model claimed fixed isn't fixed.
const STILL_BROKEN = /\b((didn'?t|doesn'?t|does not|still (doesn'?t|not|isn'?t)) work|same (error|issue|problem)|still (broken|failing|wrong|not working)|no change|nothing (changed|happened)|(error|issue|problem) (persists|remains|is still))\b/i;

const WEIGHTS = {
  interrupt: 4, apology: 2, selfCorrection: 2, sycophancy: 1, redirect: 3,
  annoyance: 3, stillBroken: 4, approachThrash: 2, overclaim: 1, toolError: 1,
  doomOrMaxSteps: 5, compactThenRedirect: 6, repeatCall: 2, sessionError: 3,
  falseSuccessThenRedirect: 5,
};

function scoreSession(events) {
  const hits = []; let score = 0;
  const counts = {};
  const add = (i, signal, w, snippet, cap = Infinity) => {
    const base = signal.split(':')[0];
    if ((counts[base] = (counts[base] || 0) + 1) > cap) return;
    hits.push({ i, signal, snippet }); score += w;
  };
  let toolErrors = 0, lastCompact = -1, lastCallKey = null, repeatRun = 1;
  let lastAssistantOverclaim = -1;

  events.forEach((e, i) => {
    if (e.kind === 'interrupt') add(i, 'user-interrupt', WEIGHTS.interrupt, '');
    if (e.kind === 'error') add(i, 'session-error', WEIGHTS.sessionError, trunc(e.text));
    if (e.kind === 'compact') lastCompact = i;
    if (e.kind === 'assistant') {
      if (APOLOGY.test(e.text)) add(i, 'assistant-apology', WEIGHTS.apology, trunc(match(APOLOGY, e.text)));
      if (SELF_CORRECTION.test(e.text)) add(i, 'assistant-self-correction', WEIGHTS.selfCorrection, trunc(match(SELF_CORRECTION, e.text)));
      if (SYCOPHANCY.test(e.text)) add(i, 'sycophancy', WEIGHTS.sycophancy, trunc(match(SYCOPHANCY, e.text)), 3);
      if (APPROACH_THRASH.test(e.text)) add(i, 'approach-thrash', WEIGHTS.approachThrash, trunc(match(APPROACH_THRASH, e.text)));
      if (OVERCLAIM.test(e.text)) { lastAssistantOverclaim = i; add(i, 'overclaim', WEIGHTS.overclaim, trunc(match(OVERCLAIM, e.text)), 3); }
    }
    if (e.kind === 'user') {
      const pushback = REDIRECT.test(e.text) || STILL_BROKEN.test(e.text) || isAnnoyed(e.text);
      if (REDIRECT.test(e.text)) add(i, 'user-redirect', WEIGHTS.redirect, trunc(match(REDIRECT, e.text)));
      if (STILL_BROKEN.test(e.text)) add(i, 'user-says-still-broken', WEIGHTS.stillBroken, trunc(match(STILL_BROKEN, e.text)));
      if (isAnnoyed(e.text)) add(i, 'user-annoyance', WEIGHTS.annoyance,
        trunc(ANNOYANCE_WORDS.test(e.text) ? match(ANNOYANCE_WORDS, e.text) : e.text));
      if (pushback) {
        if (lastCompact !== -1 && i - lastCompact <= 6) add(i, 'compact-then-redirect', WEIGHTS.compactThenRedirect, '');
        if (lastAssistantOverclaim !== -1 && i - lastAssistantOverclaim <= 2)
          add(i, 'false-success-then-redirect', WEIGHTS.falseSuccessThenRedirect, '');
      }
      // terse negation right after an assistant turn is a redirect even without keywords
      const prev = events[i - 1];
      if (prev && prev.kind !== 'user' && /^(no|nope|nah|not that|wrong)\b/i.test(e.text.trim()) && e.text.length < 80)
        add(i, 'terse-negation', WEIGHTS.redirect, trunc(e.text));
    }
    if (e.kind === 'tool-result' && e.isError && ++toolErrors <= 5)
      add(i, 'tool-error', WEIGHTS.toolError, trunc(e.text, 120));
    if (e.kind === 'tool-call') {
      if (e.toolName === 'doom_loop' || e.toolName === 'max_steps')
        add(i, 'gate:' + e.toolName, WEIGHTS.doomOrMaxSteps, '');
      const key = e.toolName + JSON.stringify(e.toolInput ?? {});
      repeatRun = key === lastCallKey ? repeatRun + 1 : 1;
      if (repeatRun === 2) add(i, 'repeated-identical-call:' + e.toolName, WEIGHTS.repeatCall, '');
      lastCallKey = key;
    }
  });
  return { score, hits, toolErrors };
}
const trunc = (s, n = 200) => (s || '').replace(/\s+/g, ' ').slice(0, n);
const match = (re, s) => { const m = s.match(re); return m ? contextOf(s, m.index) : s; };
const contextOf = (s, i) => s.slice(Math.max(0, i - 60), i + 140);

// ---------- corpus walk ----------
function listSources() {
  const out = [];
  if (LANES.includes('native')) {
    const root = path.join(HOME, '.youcoded/sessions');
    if (fs.existsSync(root)) for (const slug of fs.readdirSync(root)) {
      const d = path.join(root, slug);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl'))
        out.push({ file: path.join(d, f), lane: 'native', project: slug });
    }
  }
  if (LANES.includes('claude')) {
    const root = path.join(HOME, 'YouCoded/Personal/Conversations/claude/transcripts');
    if (fs.existsSync(root)) for (const proj of fs.readdirSync(root)) {
      const d = path.join(root, proj);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl'))
        out.push({ file: path.join(d, f), lane: 'claude', project: proj });
    }
  }
  return out.filter((s) => fs.statSync(s.file).mtimeMs >= SINCE);
}

function runScan() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sources = listSources().slice(0, LIMIT);
  const rows = []; const laneCounts = {}; let parsed = 0, skipped = 0;
  for (const src of sources) {
    let s;
    try { s = src.lane === 'native' ? parseNative(src.file) : parseClaude(src.file); }
    catch { skipped++; continue; }
    if (s.events.length < 4) { skipped++; continue; }
    parsed++; laneCounts[src.lane] = (laneCounts[src.lane] || 0) + 1;
    const { score, hits } = scoreSession(s.events);
    rows.push({
      file: src.file, lane: src.lane, project: src.project, model: s.model,
      events: s.events.length, score, hits: STATS_ONLY ? hits.map((h) => h.signal) : hits,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  fs.writeFileSync(path.join(OUT_DIR, 'scan.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const signalTotals = {};
  for (const r of rows) for (const h of r.hits) {
    const sig = typeof h === 'string' ? h : h.signal;
    signalTotals[sig] = (signalTotals[sig] || 0) + 1;
  }
  const md = [
    `# Conversation triage — stage 1 scan (${new Date().toISOString()})`,
    ``, `Parsed ${parsed} sessions (${JSON.stringify(laneCounts)}), skipped ${skipped} (unparseable or <4 events). Flagged (score>0): ${rows.filter((r) => r.score > 0).length}.`,
    ``, `## Signal totals`, ...Object.entries(signalTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    ``, `## Top sessions`,
    ...rows.slice(0, 60).map((r) =>
      `- **${r.score}** ${r.lane}/${r.project} ${path.basename(r.file)} (${r.events} ev, ${r.model ?? '?'}) — ` +
      [...new Set(r.hits.map((h) => (typeof h === 'string' ? h : h.signal)))].join(', ')),
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'scan-report.md'), md + '\n');
  console.log(`scan: ${parsed} parsed, ${skipped} skipped, ${rows.filter((r) => r.score > 0).length} flagged → ${OUT_DIR}`);
  console.log('signal totals:', signalTotals);
  return rows;
}

// ---------- stage 2: LLM triage ----------
const CATEGORIES = [
  'instruction-ignored', 'wrong-scope-or-file', 'hallucinated-claim', 'false-success-claim',
  'tool-loop-or-thrash', 'compaction-state-loss', 'format-violation', 'overreach',
  'stopped-too-early', 'misunderstood-request', 'environment-or-tool-failure', 'other',
];
const SYSTEM_PROMPT = `You are a comprehensive failure-triage reviewer for AI coding-agent session excerpts. You see windows around flagged moments (user interruptions, apologies, redirections, still-broken reports, tool errors, self-corrections). Identify EVERYTHING that actually went wrong, judging ONLY from the evidence shown. Be exhaustive within the evidence: minor friction counts (severity 1), but false positives do not — a polite "sorry" or a "great question" with nothing actually wrong is NOT an incident.
Return STRICT JSON:
{"incidents":[{
  "category": one of ${JSON.stringify(CATEGORIES)},
  "description": "one sentence, specific — what went wrong",
  "upstream_guess": "where it FIRST went wrong (errors cascade; name the earliest cause visible)",
  "harness_fix_idea": "one sentence: what mechanism (not prompt-wording) could have prevented or caught this — e.g. a check, a gate, a tool change; or 'none obvious'",
  "quote": "short verbatim quote from the excerpt",
  "severity": 1|2|3,
  "confidence": "low|medium|high",
  "wasted_user_turns": integer estimate of user messages spent correcting/re-steering because of this
}],
"user_burden": "none|light|moderate|heavy",
"worth_human_review": true|false,
"session_summary": "one sentence"}
Rules: every incident needs a verbatim quote. Do not invent context you cannot see. Prefer several specific incidents over one vague one.`;

const SYNTH_PROMPT = `You are consolidating failure incidents from many AI coding-agent sessions into a draft failure taxonomy. Input: a JSON array of incidents (category, description, upstream_guess, harness_fix_idea, quote, severity, session). Merge duplicates and near-duplicates across sessions into crisp categories — rename or split the seed categories freely when the evidence demands it.
Return STRICT JSON:
{"taxonomy":[{
  "name": "kebab-case category name",
  "definition": "1-2 sentences, precise enough that two people would label the same trace the same way",
  "count": total incidents merged into this category,
  "severity_profile": "e.g. 'mostly sev2, three sev3'",
  "exemplars": [up to 3 {"quote":"verbatim","session":"file basename"}],
  "upstream_pattern": "the recurring first-cause, one sentence",
  "suggested_assertion": "one concrete automated check for an eval suite (promptfoo-style assertion or deterministic rule) that would catch this category",
  "priority": 1|2|3  // 1 = fix/measure first: frequency x severity x tractability
}],
"cross_cutting_observations": ["patterns that span categories — model-specific, lane-specific, compaction-related, etc."],
"top_priorities": ["ordered shortlist: the 3-5 categories to build evals for first, one line of rationale each"]}
Rules: every taxonomy entry keeps verbatim exemplar quotes with session basenames so a human can spot-check. Do not pad: if the evidence supports 6 categories, return 6.`;

function buildExcerpt(sessionRow) {
  const s = sessionRow.lane === 'native' ? parseNative(sessionRow.file) : parseClaude(sessionRow.file);
  const idxs = new Set();
  for (const h of sessionRow.hits) for (let d = -3; d <= 3; d++) {
    const j = (typeof h === 'string' ? 0 : h.i) + d;
    if (j >= 0 && j < s.events.length) idxs.add(j);
  }
  const lines = [];
  let budget = 14_000;
  for (const i of [...idxs].sort((a, b) => a - b)) {
    const e = s.events[i];
    const line =
      e.kind === 'tool-call' ? `[${i}] TOOL ${e.toolName}(${trunc(JSON.stringify(e.toolInput ?? {}), 150)})`
      : e.kind === 'tool-result' ? `[${i}] RESULT${e.isError ? ' (ERROR)' : ''}: ${trunc(e.text, 250)}`
      : e.kind === 'interrupt' ? `[${i}] <USER PRESSED INTERRUPT>`
      : e.kind === 'compact' ? `[${i}] <CONTEXT COMPACTED — earlier conversation replaced by summary>`
      : `[${i}] ${e.kind.toUpperCase()}: ${trunc(e.text, 500)}`;
    if ((budget -= line.length) < 0) break;
    lines.push(line);
  }
  return lines.join('\n');
}

// Reasoning-mode models (DeepSeek et al.) can burn the whole max_tokens budget on
// reasoning and return EMPTY content — observed 36/40 on the 2026-08-11 first run,
// matching ask-the-budget's judge-comparison finding that rejected DeepSeek-with-
// reasoning as a judge (truncations). So: ask OpenRouter to disable reasoning, keep
// a generous cap, salvage JSON from the reasoning field if content is still empty,
// and drop the reasoning param on providers that 400 on it.
async function llm(userContent, { system = SYSTEM_PROMPT, model = MODEL, maxTokens = 5000 } = {}) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
  let body = { model, temperature: 0, max_tokens: maxTokens, messages, reasoning: { enabled: false } };
  let res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 400) { // provider may reject the unified reasoning param — retry bare
    body = { model, temperature: 0, max_tokens: maxTokens, messages };
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${trunc(await res.text(), 300)}`);
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  const content = msg.content || msg.reasoning_content || msg.reasoning || '';
  const cleaned = content.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  let parsed = null;
  if (start !== -1) {
    const doc = cleaned.slice(start);
    try { parsed = JSON.parse(doc.slice(0, doc.lastIndexOf('}') + 1)); }
    catch { parsed = repairTruncatedJson(doc); }
  }
  return { parsed, raw: content, usage: json.usage ?? {}, finishReason: json.choices?.[0]?.finish_reason };
}

// Providers sometimes cut a JSON stream mid-document (observed with DeepSeek flash
// on the synthesis call, finish well under our max_tokens). Walk the text tracking
// string/escape state and a bracket stack; drop a trailing partial token, close the
// open string, and append the missing closers. Slightly lossy (the cut element is
// discarded), which is fine for a draft report — the raw text is kept alongside.
function repairTruncatedJson(doc) {
  const stack = [];
  let inStr = false, esc = false, lastComplete = 0;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { stack.pop(); lastComplete = i + 1; }
    else if (c === ',') lastComplete = i;
  }
  for (const cut of [doc.length, lastComplete]) {
    // pass 1: close everything as-is; pass 2: drop the trailing partial element first
    const head = doc.slice(0, cut);
    const st = []; let s = false, e = false;
    for (const c of head) {
      if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; }
      if (c === '"') s = true;
      else if (c === '{' || c === '[') st.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') st.pop();
    }
    let candidate = head.replace(/,\s*$/, '') + (s ? '"' : '') + st.reverse().join('');
    try { return JSON.parse(candidate); } catch { /* try next cut */ }
  }
  return null;
}

async function runTriage(rows) {
  if (!rows) {
    const scanPath = path.join(OUT_DIR, 'scan.jsonl');
    if (!fs.existsSync(scanPath)) { console.error(`no ${scanPath} — run scan first (or use "both")`); process.exit(1); }
    rows = fs.readFileSync(scanPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const targets = rows.filter((r) => r.score > 0 && Array.isArray(r.hits) && typeof r.hits[0] !== 'string')
    .slice(0, Math.min(TOP, MAX_CALLS));
  if (targets.length === 0) { console.error('nothing to triage (need a scan run without --stats-only)'); process.exit(1); }

  const excerpts = targets.map((r) => ({ r, excerpt: buildExcerpt(r) }));
  const estChars = excerpts.reduce((n, e) => n + e.excerpt.length, 0);
  console.log(`triage plan: ${targets.length} sessions, model ${MODEL}, ~${Math.round(estChars / 4 / 1000)}k input tokens (+ ~${SYSTEM_PROMPT.length * targets.length / 4 / 1000 | 0}k system)`);
  if (DRY) { console.log('--dry-run: no calls made.'); return; }
  if (!process.env.OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY not set (use --dry-run to plan without a key)'); process.exit(1); }

  const findings = []; let usageIn = 0, usageOut = 0, errors = 0;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, excerpts.length) }, async () => {
    while (i < excerpts.length) {
      const mine = excerpts[i++];
      const meta = `${mine.r.lane}/${mine.r.project}/${path.basename(mine.r.file)} (model: ${mine.r.model ?? '?'}, score ${mine.r.score})`;
      try {
        const out = await llm(`Session ${meta} — flagged excerpt windows ([n] = event index; gaps are elided):\n\n${mine.excerpt}`);
        usageIn += out.usage.prompt_tokens ?? 0; usageOut += out.usage.completion_tokens ?? 0;
        findings.push({ file: mine.r.file, lane: mine.r.lane, project: mine.r.project, model: mine.r.model,
          score: mine.r.score, ...(out.parsed ?? { judge_error: true, raw: trunc(out.raw, 500) }) });
        if (!out.parsed) errors++;
      } catch (e) { errors++; findings.push({ file: mine.r.file, judge_error: true, error: String(e.message) }); }
      process.stdout.write(`\rtriaged ${findings.length}/${excerpts.length} (judge errors: ${errors})   `);
    }
  }));
  console.log();

  fs.writeFileSync(path.join(OUT_DIR, 'findings.jsonl'), findings.map((f) => JSON.stringify(f)).join('\n') + '\n');

  // ---- synthesis pass: LLM consolidates all incidents into a draft taxonomy ----
  const allIncidents = findings.flatMap((f) => (f.incidents ?? []).map((inc) => ({
    ...inc, session: path.basename(f.file), lane: f.lane, model: f.model,
  })));
  let synth = null;
  if (allIncidents.length) {
    let payload = allIncidents;
    let serialized = JSON.stringify(payload);
    if (serialized.length > 55_000) { // keep the consolidation call bounded; drop low-severity tail
      payload = [...allIncidents].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0)).slice(0, 400);
      serialized = JSON.stringify(payload);
      console.log(`synthesis: truncated to ${payload.length}/${allIncidents.length} incidents (severity-ranked) to fit the call`);
    }
    try {
      let out = await llm(`Incidents from ${findings.length} sessions:\n${serialized}`,
        { system: SYNTH_PROMPT, model: SYNTH_MODEL, maxTokens: 8000 });
      if (!out.parsed) { // one compact retry — provider-side stream cuts happen (finish_reason logged)
        console.log(`synthesis: unparseable (finish_reason=${out.finishReason}) — retrying compact`);
        out = await llm(`Incidents from ${findings.length} sessions. BE COMPACT: at most 8 categories, 2 exemplars each, terse strings.\n${serialized}`,
          { system: SYNTH_PROMPT, model: SYNTH_MODEL, maxTokens: 8000 });
      }
      usageIn += out.usage.prompt_tokens ?? 0; usageOut += out.usage.completion_tokens ?? 0;
      synth = out.parsed;
      if (!synth) { errors++; console.log(`synthesis: judge_error (finish_reason=${out.finishReason}) — raw kept in synthesis-raw.txt`); fs.writeFileSync(path.join(OUT_DIR, 'synthesis-raw.txt'), out.raw); }
    } catch (e) { errors++; console.log('synthesis failed:', e.message); }
  }

  const catCounts = {};
  for (const inc of allIncidents) catCounts[inc.category] = (catCounts[inc.category] || 0) + 1;
  const burden = {};
  for (const f of findings) if (f.user_burden) burden[f.user_burden] = (burden[f.user_burden] || 0) + 1;
  const wasted = allIncidents.reduce((n, i) => n + (Number(i.wasted_user_turns) || 0), 0);

  const md = [
    `# Conversation triage — stage 2 findings (${new Date().toISOString()})`,
    ``, `Judge: ${MODEL}${SYNTH_MODEL !== MODEL ? ` (synthesis: ${SYNTH_MODEL})` : ''}. Sessions: ${findings.length}. Incidents: ${allIncidents.length}. Judge errors: ${errors}. Tokens: ${usageIn} in / ${usageOut} out.`,
    ``, `Session burden: ${JSON.stringify(burden)}. Estimated user turns wasted on corrections across the sample: ~${wasted}.`,
    ``, `**LLM-drafted taxonomy below — skim and veto, don't re-derive. Every entry carries verbatim quotes with session basenames; spot-check a couple per category before building evals on it.**`,
    ...(synth?.taxonomy ? [
      ``, `## Draft taxonomy (LLM-consolidated)`,
      ...synth.taxonomy.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)).flatMap((t) => [
        ``, `### ${t.name}  (count ${t.count}, priority ${t.priority})`,
        `${t.definition}`,
        `- severity: ${t.severity_profile}`,
        `- upstream pattern: ${t.upstream_pattern}`,
        `- suggested eval assertion: ${t.suggested_assertion}`,
        ...(t.exemplars ?? []).map((x) => `- "${x.quote}" — ${x.session}`),
      ]),
      ``, `## Cross-cutting observations`,
      ...(synth.cross_cutting_observations ?? []).map((x) => `- ${x}`),
      ``, `## Recommended eval-build order`,
      ...(synth.top_priorities ?? []).map((x, n) => `${n + 1}. ${x}`),
    ] : [``, `## Synthesis unavailable (judge error) — raw category counts only`]),
    ``, `## Raw per-session category counts (pre-consolidation)`,
    ...Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    ``, `## Sessions judged worth human review`,
    ...findings.filter((f) => f.worth_human_review).map((f) => `- ${f.lane}/${f.project}/${path.basename(f.file)} — ${f.session_summary ?? ''} (burden: ${f.user_burden ?? '?'})`),
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'triage-report.md'), md + '\n');
  console.log(`findings → ${path.join(OUT_DIR, 'triage-report.md')}`);
  console.log(`tokens: ${usageIn} in / ${usageOut} out — check openrouter.ai/activity for cost.`);
}

// ---------- main ----------
if (cmd === 'scan') runScan();
else if (cmd === 'triage') await runTriage(null);
else { const rows = runScan(); if (STATS_ONLY) { console.error('both: --stats-only scan cannot feed triage; rerun without it'); process.exit(1); } await runTriage(rows); }
