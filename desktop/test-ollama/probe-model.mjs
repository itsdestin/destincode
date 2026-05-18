#!/usr/bin/env node
// Capability probe for an Ollama model via the OpenAI-compat endpoint —
// the same surface OpenCode uses, so results mirror production behavior.
//
// Usage:   node probe-model.mjs <model:tag> [--out <dir>]
// Output:  ./<model-slug>.probe.json + a single-line console summary
//
// What it tests (one HTTP request each, sequential):
//   1. /api/show            → context length, capabilities, parameters
//   2. basic                → "What is 2+2?" — sanity, time-to-content
//   3. tools                → multiply tool + "use it to compute 5*7"
//   4. thinking-none        → reasoning_effort:"none" + reasoning prompt
//   5. thinking-low/med/high→ same prompt with each level (separately)
//   6. multimodal           → 1×1 PNG + "describe this image"
//
// For each request we capture:
//   - ok / status
//   - elapsed_ms
//   - response shape (which fields are populated)
//   - content / reasoning lengths
//   - tool_calls if present
//   - error text on failure
//
// The script never throws — all errors are captured into the result JSON
// so a single bad model can't kill the batch. Per-probe timeout is 90s.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const TIMEOUT_MS = 90_000;

// Reasoning probe prompt — chosen to elicit non-trivial reasoning so we can
// measure depth-difference across effort levels. Asks for explicit reasoning
// so a model that doesn't separate it will at least put it in `content`.
const REASONING_PROMPT = 'What is 17 times 23? Walk through your reasoning step by step before giving the final answer.';

// Tool definition — simple integer multiply. Spec is OpenAI-compatible.
const MULTIPLY_TOOL = {
  type: 'function',
  function: {
    name: 'multiply',
    description: 'Multiply two integers and return the product.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'integer', description: 'First integer' },
        b: { type: 'integer', description: 'Second integer' },
      },
      required: ['a', 'b'],
    },
  },
};

// 1×1 transparent PNG as base64. Smallest valid PNG. Models that support
// images should accept this and return *something* (even if just "a tiny
// transparent square"); models that don't will error or ignore the part.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function callOpenAI(body, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const elapsed_ms = Date.now() - t0;
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* leave null, capture raw */ }
    if (!res.ok) {
      return { ok: false, label, status: res.status, elapsed_ms, error: text.slice(0, 600) };
    }
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      ok: true,
      label,
      status: res.status,
      elapsed_ms,
      finish_reason: data?.choices?.[0]?.finish_reason ?? null,
      message_keys: Object.keys(msg),
      content_len: (msg.content ?? '').length,
      reasoning_len: (msg.reasoning ?? msg.reasoning_content ?? '').length,
      content_preview: (msg.content ?? '').slice(0, 200),
      reasoning_preview: (msg.reasoning ?? msg.reasoning_content ?? '').slice(0, 200),
      tool_calls: msg.tool_calls ?? null,
      usage: data?.usage ?? null,
    };
  } catch (e) {
    return { ok: false, label, status: 0, elapsed_ms: Date.now() - t0, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function showModel(model) {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/show`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text().catch(() => '') };
    const data = await res.json();
    return {
      ok: true,
      // Top-level capability list Ollama 0.20+ exposes (think, tools, vision, embedding).
      capabilities: data.capabilities ?? null,
      details: data.details ?? null,
      // Modelfile lets us see the template + parser/renderer Ollama uses.
      modelfile_excerpt: (data.modelfile ?? '').slice(0, 1200),
      template: data.template ?? null,
      parameters: data.parameters ?? null,
      model_info: data.model_info ? {
        context_length: data.model_info['general.context_length'] ?? data.model_info[`${data.details?.family ?? ''}.context_length`] ?? null,
        param_count: data.model_info['general.parameter_count'] ?? null,
        architecture: data.model_info['general.architecture'] ?? null,
      } : null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function probe(model) {
  const t0 = Date.now();
  const result = { model, started: new Date().toISOString(), probes: {} };

  // 1. Model metadata.
  result.show = await showModel(model);

  // 2. Basic.
  result.probes.basic = await callOpenAI({
    model,
    messages: [{ role: 'user', content: 'What is 2+2? Answer in one word.' }],
    stream: false,
  }, 'basic');

  // 3. Tools.
  result.probes.tools = await callOpenAI({
    model,
    messages: [{ role: 'user', content: 'Please use the multiply tool to compute 5 times 7.' }],
    tools: [MULTIPLY_TOOL],
    stream: false,
  }, 'tools');

  // 4-7. Thinking levels.
  for (const effort of ['none', 'low', 'medium', 'high']) {
    result.probes[`thinking_${effort}`] = await callOpenAI({
      model,
      messages: [{ role: 'user', content: REASONING_PROMPT }],
      reasoning_effort: effort,
      stream: false,
    }, `thinking_${effort}`);
  }

  // 8. Multimodal — OpenAI-compat image_url parts. Some models error
  // (no vision), some ignore the image silently — both are captured.
  result.probes.multimodal = await callOpenAI({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image in one short sentence.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
      ],
    }],
    stream: false,
  }, 'multimodal');

  result.elapsed_ms = Date.now() - t0;
  return result;
}

function summarize(r) {
  const p = r.probes;
  const basic = p.basic?.ok ? 'Y' : 'N';
  const tools = p.tools?.ok && Array.isArray(p.tools.tool_calls) && p.tools.tool_calls.length > 0 ? 'Y' : 'N';
  // Reasoning honored if at least one level produces non-empty reasoning_len.
  const reasoningLens = ['none', 'low', 'medium', 'high'].map((l) => p[`thinking_${l}`]?.reasoning_len ?? 0);
  const reasoningWorks = reasoningLens.some((n, i) => i > 0 && n > 0);  // any non-none level produces reasoning
  const reasoningGraduated = new Set(reasoningLens.slice(1).filter((n) => n > 0)).size > 1; // depths vary
  const multi = p.multimodal?.ok ? 'Y' : 'N';
  return [
    `model=${r.model}`,
    `basic=${basic}`,
    `tools=${tools}`,
    `reasoning=${reasoningWorks ? (reasoningGraduated ? 'graduated' : 'binary') : 'none'}`,
    `reasoning_lens=${reasoningLens.join('/')}`,
    `multimodal=${multi}`,
    `caps=${(r.show?.capabilities ?? []).join(',') || '-'}`,
    `elapsed=${(r.elapsed_ms / 1000).toFixed(1)}s`,
  ].join('  ');
}

// ─── main ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.error('usage: node probe-model.mjs <model:tag> [--out <dir>]');
  process.exit(1);
}
const model = argv[0];
const outIdx = argv.indexOf('--out');
const outDir = outIdx > 0 ? resolve(argv[outIdx + 1]) : resolve('./results');
mkdirSync(outDir, { recursive: true });

const slug = model.replace(/[:.\/]/g, '-');
const outPath = join(outDir, `${slug}.probe.json`);

console.error(`[probe] ${model} → ${outPath}`);
const result = await probe(model);
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(summarize(result));
