// GGUF filename → quant metadata (spec §4.2). PURE — no fs/network — so the
// unsloth fixture tests pin every naming family we claim to support:
//   standard  …-Q4_K_M.gguf / …-Q8_0.gguf / …-IQ2_XXS.gguf / …-F16.gguf
//   unsloth   …-UD-Q4_K_XL.gguf (dynamic quants, often in a subfolder)
//   mxfp4     …-MXFP4.gguf / …-MXFP4_MOE.gguf (gpt-oss / MoE native 4-bit)
//   splits    …-00001-of-000NN.gguf (downloaded as a set, addressed via part 1)
// Aux files (mmproj* vision projectors, mtp-* draft models) are DENYLISTED —
// they are not chat models (Amendment 2026-07-14 E).
import type { QuantOption } from '../../shared/model-manager-types';

export interface ParsedGgufName {
  base: string;
  quant: string;               // includes the UD- prefix for dynamic quants
  dynamic: boolean;            // unsloth dynamic (UD-) quant
  part: { index: number; of: number } | null;
}

// Quant token grammar: optional UD- prefix, then (I)Q<digit>_SUFFIX, a raw
// float type, or MXFP4(_MOE) (gpt-oss / MoE native 4-bit). Anchored to a '-'
// separator and the .gguf extension so model names containing 'q4' mid-word
// can't false-match. Case-sensitive on purpose (lowercase float tokens never
// appear in real chat-model filenames).
const NAME_RE = /^(.+?)-(UD-)?((?:I?Q\d+_[A-Z0-9_]+)|Q\d+|F16|F32|BF16|MXFP4_MOE|MXFP4)(?:-(\d{5})-of-(\d{5}))?\.gguf$/;

// Aux-file denylist (Amendment 2026-07-14 E): vision projectors ('mmproj*',
// UPPERCASE in real repos) and MTP speculative-decode draft models ('mtp-*',
// often in an 'MTP/' subfolder — the basename check catches both). These are
// NOT chat models and must never appear as downloadable quants. Matched on the
// BASENAME, case-insensitively.
const AUX_BASENAME_RE = /^(mmproj|mtp-)/i;

export function parseGgufName(fileName: string): ParsedGgufName | null {
  const base = fileName.split('/').pop() ?? fileName; // callers may pass repo-relative paths
  if (AUX_BASENAME_RE.test(base)) return null;        // projector / draft model — skip
  const m = NAME_RE.exec(base);
  if (!m) return null;
  return {
    base: m[1],
    quant: `${m[2] ?? ''}${m[3]}`,
    dynamic: m[2] === 'UD-',
    part: m[4] ? { index: Number(m[4]), of: Number(m[5]) } : null,
  };
}

/** Plain-language quality/size description per quant family (spec §4.2). */
export function quantDescription(quant: string): string {
  const q = quant.replace(/^UD-/, '');
  if (/^MXFP4/.test(q)) return 'Native 4-bit — the format this model ships in, recommended';
  if (/^(F16|F32|BF16)$/.test(q)) return 'Original precision — largest download, no quality loss';
  if (/^Q8/.test(q)) return 'Highest quality quantization — near-original output';
  if (/^Q6/.test(q)) return 'Very high quality — slightly smaller than Q8';
  if (/^Q5/.test(q)) return 'High quality — a good step down in size';
  if (/^Q4/.test(q)) return quant.startsWith('UD-')
    ? 'Recommended — unsloth dynamic quant, best quality for the size'
    : 'Recommended balance of quality and size';
  if (/^(I?Q3)/.test(q)) return 'Compact — noticeable quality loss on hard tasks';
  return 'Smallest — significant quality loss, fits tight machines';
}

interface TreeFile { path: string; size: number; sha256: string | null; }

/** Group a repo's GGUF files into downloadable quant options. Multi-part sets
 *  are ordered by part index and must be COMPLETE — a set missing any part is
 *  dropped (downloading it would produce an unloadable model). */
export function groupQuantOptions(files: TreeFile[]): QuantOption[] {
  const byQuant = new Map<string, { files: { path: string; size: number; sha256: string | null; part: number }[]; of: number }>();
  for (const f of files) {
    const parsed = parseGgufName(f.path);
    if (!parsed) continue;
    const entry = byQuant.get(parsed.quant) ?? { files: [], of: parsed.part?.of ?? 1 };
    entry.of = Math.max(entry.of, parsed.part?.of ?? 1);
    entry.files.push({ path: f.path, size: f.size, sha256: f.sha256, part: parsed.part?.index ?? 1 });
    byQuant.set(parsed.quant, entry);
  }
  const out: QuantOption[] = [];
  for (const [quant, entry] of byQuant) {
    entry.files.sort((a, b) => a.part - b.part);
    const indices = entry.files.map((f) => f.part);
    const complete = indices.length === entry.of && indices.every((idx, i) => idx === i + 1);
    if (!complete) continue; // incomplete split set — undownloadable, skip
    out.push({
      quant,
      description: quantDescription(quant),
      files: entry.files.map((f) => f.path),
      totalSizeBytes: entry.files.reduce((s, f) => s + f.size, 0),
      sha256ByFile: Object.fromEntries(entry.files.map((f) => [f.path, f.sha256])),
    });
  }
  // Small-to-large reads naturally in the picker UI.
  return out.sort((a, b) => a.totalSizeBytes - b.totalSizeBytes);
}
