// Hugging Face Hub client (spec §4.2). Every consumed field is recorded in
// docs/provider-dependencies.md; parse DEFENSIVELY — rows missing required
// fields are skipped, absent optional fields become null (never guessed).
import type { HFSearchHit, QuantOption } from '../../shared/model-manager-types';
import { groupQuantOptions } from './quant-parser';

const API = 'https://huggingface.co/api';
const FETCH_TIMEOUT_MS = 15_000;

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;

export function hfResolveUrl(repo: string, filePath: string): string {
  // repo is 'owner/name' — the slash is a real URL separator; file path
  // segments are encoded individually (subfolders stay subfolders).
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repo}/resolve/main/${encodedPath}`;
}

export class HfClient {
  constructor(private fetchImpl: FetchLike = fetch as any) {}

  async search(query: string): Promise<HFSearchHit[]> {
    const url = `${API}/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=30`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error('Hugging Face search is not reachable right now — try again in a moment.');
    const rows = await res.json();
    const out: HFSearchHit[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.id !== 'string') continue; // skip malformed
      out.push({
        repo: row.id,
        downloads: typeof row.downloads === 'number' ? row.downloads : 0,
        likes: typeof row.likes === 'number' ? row.likes : 0,
      });
    }
    return out;
  }

  /** List a repo's downloadable quant variants. recursive=true is REQUIRED:
   *  unsloth keeps dynamic quants in subfolders. */
  async quantOptions(repo: string): Promise<QuantOption[]> {
    const url = `${API}/models/${repo}/tree/main?recursive=true`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error("Could not list this model's files on Hugging Face — try again in a moment.");
    const rows = await res.json();
    const files = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.type !== 'file' || typeof row?.path !== 'string' || typeof row?.size !== 'number') continue;
      files.push({
        path: row.path,
        size: row.size,
        // lfs.oid is the blob's sha256 for LFS files (all real GGUFs); absent
        // for small non-LFS files — downloader skips verification then.
        sha256: typeof row?.lfs?.oid === 'string' && /^[0-9a-f]{64}$/.test(row.lfs.oid) ? row.lfs.oid : null,
      });
    }
    return groupQuantOptions(files);
  }
}
