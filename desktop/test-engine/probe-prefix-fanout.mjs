// test-engine/probe-prefix-fanout.mjs — does KV prefix reuse survive PARALLEL
// fan-out? (specialists spec §4 "KV-cache discipline", §8 live probe 2.)
// NOT a unit test: run against a live llama-server.
//
// WHY this exists next to probe-prefix-cache.mjs: that probe sends its two
// requests one after the other, so the second one lands in the SAME slot and
// finds the prefix already there. A plan fans N children out AT ONCE, so they
// land in N different slots — and each slot has its own KV cache. The question
// stage two's plan card depends on is whether the router copies a cached prefix
// into a fresh slot (cheap fan-out) or every child pays the full prefill
// (fan-out costs N× what the card would promise).
//
// Three waves, one already-loaded model, all sharing one ~2,000-token system
// prefix P and differing only in the user turn:
//   wave 0  one request with P — the cold prefill (loads P into one slot)
//   wave 1  N simultaneous requests with P — the fan-out this probe is about
//   wave 2  N simultaneous requests with P again — steady state, every slot
//           has now seen P at least once
// Each request reports the server's own `timings.prompt_n` (tokens actually
// prefilled) and `timings.prompt_ms`. Reuse "survives fan-out" if wave 1's
// requests prefill far fewer tokens than the cold request did.
//
// Launch a server first, matching engine-supervisor.ts's router-mode spawn,
// with an explicit slot count so N is meaningful:
//
//   llama-server --host 127.0.0.1 --port 8199 --no-webui --jinja \
//     --models-dir <cacheDir> --models-max 2 --sleep-idle-seconds 300 \
//     -c <contextSize> --parallel 4
//
// Usage: node test-engine/probe-prefix-fanout.mjs <baseURL> <modelId> [N=4]
const [base, model, nArg] = process.argv.slice(2);
if (!base || !model) { console.error('usage: probe-prefix-fanout.mjs <baseURL> <modelId> [N]'); process.exit(2); }
const N = Number(nArg ?? 4);

// Same filler construction as probe-prefix-cache.mjs so the two probes measure
// the same prefix size; the server's `prompt_n` is the ground truth.
function buildPrefix(seed, approxTokens = 2000) {
  const sentence = `Seed ${seed}: the quarterly engineering review covers parallel workstream coordination, specialist dispatch discipline, and prefix-sharing across simultaneous child requests handled by the router. `;
  const repeats = Math.ceil(approxTokens / 33);
  return Array.from({ length: repeats }, (_, i) => `[${seed}-${i}] ${sentence}`).join('');
}
const PREFIX = buildPrefix('P');

async function chat(userContent) {
  const start = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: PREFIX }, { role: 'user', content: userContent }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const wall = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const t = json.timings ?? {};
  return { wall, promptN: t.prompt_n ?? null, promptMs: t.prompt_ms ?? null, cacheN: t.cache_n ?? null };
}

function row(label, r) {
  const pn = r.promptN == null ? '   n/a' : String(r.promptN).padStart(6);
  const cn = r.cacheN == null ? '   n/a' : String(r.cacheN).padStart(6);
  const pm = r.promptMs == null ? '     n/a' : r.promptMs.toFixed(0).padStart(8);
  console.log(` ${label.padEnd(14)} | ${pn} | ${cn} | ${pm} | ${r.wall.toFixed(0).padStart(7)}`);
}

(async () => {
  console.log(`probe-prefix-fanout: ${model} @ ${base}, N=${N}`);
  // Warm-up pays the model load AND loads P into one slot (it uses P). So the
  // table's cold baseline below uses a never-seen prefix variant instead.
  await chat('warm-up: reply with one word.');
  const coldPrefixReq = async () => {
    const start = performance.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: buildPrefix('COLD') }, { role: 'user', content: 'one word.' }], max_tokens: 8, temperature: 0 }),
    });
    const wall = performance.now() - start; const json = await res.json(); const t = json.timings ?? {};
    return { wall, promptN: t.prompt_n ?? null, promptMs: t.prompt_ms ?? null, cacheN: t.cache_n ?? null };
  };

  console.log('\n request        | prompt_n | cache_n | prompt_ms | wall_ms');
  console.log('----------------|----------|---------|-----------|--------');
  const cold = await coldPrefixReq();
  row('cold (new P)', cold);

  const wave1 = await Promise.all(Array.from({ length: N }, (_, i) => chat(`Child ${i + 1}: reply with the number ${i + 1} only.`)));
  wave1.forEach((r, i) => row(`wave1 child ${i + 1}`, r));

  const wave2 = await Promise.all(Array.from({ length: N }, (_, i) => chat(`Child ${i + 1} again: reply with the number ${i + 1} only.`)));
  wave2.forEach((r, i) => row(`wave2 child ${i + 1}`, r));

  const avg = (rs, k) => rs.reduce((a, r) => a + (r[k] ?? 0), 0) / rs.length;
  const coldN = cold.promptN ?? 1;
  const w1 = avg(wave1, 'promptN'), w2 = avg(wave2, 'promptN');
  const w1ms = avg(wave1, 'promptMs'), w2ms = avg(wave2, 'promptMs');
  console.log(`\ncold prefill: ${coldN} tokens in ${(cold.promptMs ?? 0).toFixed(0)} ms`);
  console.log(`wave 1 (fan-out) avg prefill: ${w1.toFixed(0)} tokens (${((w1 / coldN) * 100).toFixed(0)}% of cold) in ${w1ms.toFixed(0)} ms`);
  console.log(`wave 2 (steady)  avg prefill: ${w2.toFixed(0)} tokens (${((w2 / coldN) * 100).toFixed(0)}% of cold) in ${w2ms.toFixed(0)} ms`);
  // Three tiers, not two. WHY: on the 2026-09-04 run the first fan-out
  // averaged 48% of a cold prefill — two children reused, two paid in full —
  // and a plain "<50% = survives" call would have hidden that half the
  // children still pay. The plan card's cost preview has to know which tier.
  const r1 = w1 / coldN, r2 = w2 / coldN;
  const verdict = r1 < 0.25 ? 'REUSE SURVIVES FAN-OUT (first wave already cheap)'
    : r1 < 0.75 && r2 < 0.25 ? 'PARTIAL: the first fan-out of a new prefix pays full prefill on some children; later waves reuse'
    : r2 < 0.25 ? 'REUSE ONLY AFTER EVERY SLOT HAS SEEN THE PREFIX ONCE (first fan-out pays full prefill)'
    : 'NO REUSE ACROSS SLOTS';
  console.log(`\nVERDICT: ${verdict}`);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
