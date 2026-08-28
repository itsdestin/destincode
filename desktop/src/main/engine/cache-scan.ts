// GGUF cache scan — the engine-off view of "what local models exist".
// Router-mode llama-server discovers the same directory (--models-dir, NOT
// LLAMA_CACHE — that one is vestigial), so the ids derived here MUST match what
// GET /models reports once the engine is running — with ONE known difference:
// the router lists one row per FILE, so a split set appears there as N rows
// while this scan collapses it to the first part. That is listing granularity,
// not a naming mismatch; EngineSupervisor.listModels drops the follower rows
// (shared/gguf-split.ts) and probe-models.mjs folds them before comparing.
// Measured on b10665, 2026-08-27, after four rows for one model reached the
// picker and three of them 500'd. It scans that dir at BOOT and
// never again on its own, so this scan can legitimately be AHEAD of the router
// for a file downloaded since — that gap is what EngineSupervisor.ensureServable
// closes, and reading a row from here as "usable" is the 2026-08-16 bug.
// ONE scan, TWO views: scanLocalDownloads reports every download on disk in
// whatever state it is in (the Settings list), and scanGgufCache is that
// filtered to complete sets (everything else, including the conversation model
// picker). Deriving one from the other is deliberate — two independent scans of
// the same directory can disagree, and a half-downloaded split model listed as
// installed was exactly that bug (2026-08-26).
// The id equivalence is an EMPIRICAL contract, pinned by
// test-engine/probe-models.mjs and recorded in docs/engine-dependencies.md —
// if a probe run shows the router naming models differently, fix
// ggufIdFromFileName (one function) and update the probe assertion together.
import * as fs from 'fs';
import * as path from 'path';
import type { EngineModel } from '../../shared/engine-types';
import { MANIFEST_SUFFIX } from '../models/download-manifest';

// llama.cpp split-GGUF convention: <name>-00001-of-000NN.gguf. The model is
// addressed through its FIRST part; other parts are the same model's payload.
const PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

export function ggufIdFromFileName(fileName: string): string {
  return fileName.replace(/\.gguf$/i, '');
}

/** One download's footprint on disk, in whatever state it is in. */
export interface LocalDownload {
  modelId: string;         // first-part id — what models:delete takes
  firstFileName: string;   // basename incl. .gguf — the manifest key
  partsDeclared: number;   // from the -of-000NN suffix; 1 for single-file
  partsPresent: number;    // published .gguf files found for this set
  bytesPublished: number;
  bytesPartial: number;
  hasPartial: boolean;
  hasManifest: boolean;    // a manifest file exists (parsed by engine-manager, not here)
}

/** A download is usable only when every declared part is published. A stray
 *  .partial or manifest alongside a full set does NOT demote it — publication
 *  is an atomic rename, so the file count is the authority (spec §3.2). */
export function isComplete(d: LocalDownload): boolean {
  return d.partsPresent >= d.partsDeclared;
}

/** Every GGUF download in the cache dir, complete or not — the Settings view.
 *  Groups a split set under its first part and reports published vs in-flight
 *  bytes separately. A manifest with no bytes yet is a download too (it is
 *  written before the first fetch). */
export function scanLocalDownloads(cacheDir: string): LocalDownload[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return []; // cache dir not created yet — no downloads, not an error
  }
  const sets = new Map<string, LocalDownload>();
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const published = /\.gguf$/i.test(ent.name);
    const partial = /\.gguf\.partial$/i.test(ent.name);
    const manifest = ent.name.endsWith(`.gguf${MANIFEST_SUFFIX}`);
    if (!published && !partial && !manifest) continue;   // notes, .tmp, anything else
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(path.join(cacheDir, ent.name)).size; } catch { continue; } // raced delete
    // The final filename this entry belongs to ('X.gguf.partial' -> 'X.gguf',
    // 'X.gguf.download.json' -> 'X.gguf').
    const finalName = partial ? ent.name.replace(/\.partial$/i, '')
      : manifest ? ent.name.slice(0, -MANIFEST_SUFFIX.length)
      : ent.name;
    const part = PART_RE.exec(finalName);
    const firstFileName = part ? finalName.replace(PART_RE, `-00001-of-${part[2]}.gguf`) : finalName;
    let set = sets.get(firstFileName);
    if (!set) {
      set = {
        modelId: ggufIdFromFileName(firstFileName),
        firstFileName,
        partsDeclared: part ? Number(part[2]) : 1,
        partsPresent: 0,
        bytesPublished: 0,
        bytesPartial: 0,
        hasPartial: false,
        hasManifest: false,
      };
      sets.set(firstFileName, set);
    }
    if (published) { set.partsPresent += 1; set.bytesPublished += sizeBytes; }
    else if (partial) { set.hasPartial = true; set.bytesPartial += sizeBytes; }
    else { set.hasManifest = true; }
  }
  return [...sets.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** The engine-off view — complete downloads only.
 *
 *  INCOMPLETE SETS ARE OMITTED BY CONSTRUCTION. Everything downstream of this
 *  function — listModels, liveModels, engine:models, the conversation model
 *  picker — inherits that, so there is no second place to remember the rule.
 *  A half-downloaded split model listed as installed was the 2026-08-26 bug. */
export function scanGgufCache(cacheDir: string): EngineModel[] {
  return scanLocalDownloads(cacheDir)
    .filter(isComplete)
    .map((d) => ({
      id: d.modelId,
      sizeBytes: d.bytesPublished,
      loaded: false,
      state: 'unloaded' as const, // cache scan = engine-off view; nothing is resident
    }));
}
