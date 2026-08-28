// llama.cpp's split-GGUF convention, expressed over MODEL IDs (a filename minus
// its .gguf extension). cache-scan.ts owns the filename-level version; this one
// exists because the running router reports IDs, not filenames, from GET /models
// — and both main and renderer need the same answer about them.
//
// A split set is ONE model. Part 00001 carries the description + vocabulary and
// is the address the engine loads the whole set through; parts 2..N hold weights
// only and have no architecture in them, so loading one can never succeed.
// Anything that LISTS models must therefore drop the followers.
//
// WHY this file exists (2026-08-27): the model picker showed four rows for one
// four-part Qwen3.8-Flash-Next download and three of them 500'd on selection.
// The disk scan (scanGgufCache) had always grouped split sets correctly, but the
// picker only uses that scan while the engine is STOPPED — once it is running,
// listModels() asks the router instead, and the router lists one row per file.
// The grouping was being bypassed at exactly the moment it mattered.

const PART_ID_RE = /-(\d{5})-of-(\d{5})$/;

/** True for a split part that is NOT the loadable first part. Never offer one
 *  as a selectable model — it has no architecture header to load. */
export function isFollowerPart(modelId: string): boolean {
  const m = PART_ID_RE.exec(modelId);
  return m !== null && Number(m[1]) !== 1;
}

/** Drop the `-00001-of-00004` marker for display. Loading still uses the raw id
 *  — this is a label transform only. Never returns an empty string. */
export function stripSplitSuffix(modelId: string): string {
  return modelId.replace(PART_ID_RE, '') || modelId;
}
