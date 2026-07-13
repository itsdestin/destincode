#!/usr/bin/env node
// Probe: streamed /v1/chat/completions with auto-load (harness-session +
// provider-registry coupling — the exact call path @ai-sdk/openai-compatible
// makes, minus the SDK). Names an UNLOADED model to prove router auto-load.
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary || binary.startsWith('--')) { console.error('usage: probe-chat.mjs --binary <llama-server>'); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, 'cache');
const PORT = 9973;

const gguf = fs.readdirSync(cacheDir).find((f) => f.endsWith('.gguf'));
if (!gguf) { console.error('FAIL: put a small .gguf in test-engine/cache/ first'); process.exit(1); }
const modelId = gguf.replace(/\.gguf$/i, '');

const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--jinja', '--models-dir', cacheDir, '-c', '4096'],
  { env: { ...process.env, LLAMA_CACHE: cacheDir }, stdio: ['ignore', 'inherit', 'inherit'] });
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: modelId, // names an UNLOADED model — this request must auto-load it
    stream: true,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  }),
});
console.log('HTTP', res.status);
let text = '';
let sawUsage = false;
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    const obj = JSON.parse(payload);
    text += obj.choices?.[0]?.delta?.content ?? '';
    if (obj.usage || obj.timings) { sawUsage = true; console.log('FINAL FRAME:', JSON.stringify(obj)); }
  }
}
child.kill();
if (res.status !== 200 || text.length === 0) { console.error('FAIL: no streamed content'); process.exit(1); }
console.log('PASS: auto-load + streamed completion. text =', JSON.stringify(text), 'usage/timings seen =', sawUsage);
