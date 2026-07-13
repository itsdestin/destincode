// GGUF cache scan — the engine-off view of "what local models exist".
// Router-mode llama-server auto-discovers the same directory (LLAMA_CACHE), so
// the ids derived here MUST match what GET /models reports once the engine is
// running. That equivalence is an EMPIRICAL contract, pinned by
// test-engine/probe-models.mjs and recorded in docs/engine-dependencies.md —
// if a probe run shows the router naming models differently, fix
// ggufIdFromFileName (one function) and update the probe assertion together.
import * as fs from 'fs';
import * as path from 'path';
import type { EngineModel } from '../../shared/engine-types';

// llama.cpp split-GGUF convention: <name>-00001-of-000NN.gguf. The model is
// addressed through its FIRST part; other parts are the same model's payload.
const PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

export function ggufIdFromFileName(fileName: string): string {
  return fileName.replace(/\.gguf$/i, '');
}

export function scanGgufCache(cacheDir: string): EngineModel[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return []; // cache dir not created yet — no local models, not an error
  }
  const out = new Map<string, EngineModel>();
  const partSizes = new Map<string, number>(); // first-part id → summed extra bytes
  for (const ent of entries) {
    if (!ent.isFile() || !/\.gguf$/i.test(ent.name)) continue;
    let sizeBytes: number | null = null;
    try { sizeBytes = fs.statSync(path.join(cacheDir, ent.name)).size; } catch { /* raced delete */ }
    const part = PART_RE.exec(ent.name);
    if (part && part[1] !== '00001') {
      // Non-first parts fold their size into the first part's entry.
      const firstName = ent.name.replace(PART_RE, `-00001-of-${part[2]}.gguf`);
      const firstId = ggufIdFromFileName(firstName);
      partSizes.set(firstId, (partSizes.get(firstId) ?? 0) + (sizeBytes ?? 0));
      continue;
    }
    out.set(ggufIdFromFileName(ent.name), {
      id: ggufIdFromFileName(ent.name),
      sizeBytes,
      loaded: false,
    });
  }
  for (const [firstId, extra] of partSizes) {
    const first = out.get(firstId);
    if (first && first.sizeBytes !== null) first.sizeBytes += extra;
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
