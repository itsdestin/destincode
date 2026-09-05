// test-engine/probe-tools.mjs — constrained tool-call round-trip + capability
// report against a live llama-server (spec §4.2/§4.1). NOT a unit test: run against
// a running engine to (a) confirm --jinja tool-calling emits schema-valid JSON args,
// (b) confirm a plain prompt still answers WITHOUT a forced tool call, and (c) report
// the real loaded context window (/props) — the ground truth the known-model registry
// is checked against.  Usage: node test-engine/probe-tools.mjs http://127.0.0.1:<port> <model-id>
const [base, model] = process.argv.slice(2);
if (!base || !model) { console.error('usage: probe-tools.mjs <baseURL> <modelId>'); process.exit(2); }
const READ_TOOL = { type: 'function', function: { name: 'Read', description: 'Read a file from disk.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } };
async function chat(body) {
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, ...body }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
(async () => {
  // WHY ?model= (2026-09-04): router-mode /props only describes the named model — bare /props answers
  // n_ctx 0 with no slot field. With the model named, n_ctx is what the engine holds for that model
  // (the FULL -c under the app's spawn, which has no --parallel and so shares one unified KV pool
  // across all slots; -c / N only with an explicit --parallel N) and total_slots (n_slots on older
  // builds) is the parallel-slot count the app's concurrency cap reads. NOTE: on b10665 naming a
  // model AUTOLOADS it — fine here (this probe loads it for the chat calls anyway), never in the app.
  try { const props = await (await fetch(`${base}/props?model=${encodeURIComponent(model)}`)).json(); console.log('ctx  loaded n_ctx =', props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? '(field not found — check the pinned build)', ' total_slots =', props?.total_slots ?? props?.n_slots ?? '(field not found — check the pinned build)'); } catch { console.log('ctx  /props unavailable'); }
  const toolResp = await chat({ messages: [{ role: 'user', content: 'Read the file at src/index.ts using the Read tool.' }], tools: [READ_TOOL], tool_choice: 'auto', parallel_tool_calls: false });
  const call = toolResp.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('FAIL: no tool_call emitted for a tool-y prompt (this model may not support tool calling)');
  let args; try { args = JSON.parse(call.function.arguments); } catch { throw new Error(`FAIL: tool args not valid JSON: ${call.function.arguments}`); }
  if (typeof args.file_path !== 'string') throw new Error(`FAIL: args missing file_path: ${JSON.stringify(args)}`);
  console.log('OK   tool-call args are schema-valid JSON:', JSON.stringify(args));
  const textResp = await chat({ messages: [{ role: 'user', content: 'In one sentence, what is 2+2?' }], tools: [READ_TOOL], tool_choice: 'auto', parallel_tool_calls: false });
  if (textResp.choices?.[0]?.message?.tool_calls?.length) throw new Error('FAIL: forced a tool call on a plain-text prompt (never-force invariant)');
  console.log('OK   plain prompt answered without a tool call');
  console.log(`\nPASS  ${model} @ ${base} — constrained tool-calling verified.`);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
