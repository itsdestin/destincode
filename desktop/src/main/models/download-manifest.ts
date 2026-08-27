// Records WHERE a download came from, so a leftover .partial can still be
// resumed after a crash or quit. Written BEFORE the first byte; removed only on
// clean completion of the whole file set.
//
// A sidecar beside the files rather than a central registry: it travels with
// the download, so it cannot drift out of sync with the cache dir, and it
// survives the user repointing engine.cacheDir.
//
// Spec: docs/active/specs/2026-08-26-model-download-resume-design.md §3.1
import * as fs from 'fs';
import * as path from 'path';
import type { DownloadManifest, QuantOption } from '../../shared/model-manager-types';

/** `<first-file-basename>.gguf.download.json`. Exported so cache-scan can
 *  recognise a manifest without knowing anything else about it. */
export const MANIFEST_SUFFIX = '.download.json';

/** The manifest path for a download, keyed to its FIRST file's basename — the
 *  same id models:delete addresses a split model by. */
export function manifestPathFor(cacheDir: string, firstFileBasename: string): string {
  return path.join(cacheDir, `${firstFileBasename}${MANIFEST_SUFFIX}`);
}

export function writeManifest(cacheDir: string, repo: string, quant: QuantOption, startedAt: number): void {
  const manifest: DownloadManifest = {
    v: 1,
    repo,
    quant: quant.quant,
    files: quant.files,
    totalSizeBytes: quant.totalSizeBytes,
    sha256ByFile: quant.sha256ByFile,
    startedAt,
  };
  const target = manifestPathFor(cacheDir, path.basename(quant.files[0]));
  // Write-then-rename: a crash mid-write must leave NO manifest rather than half
  // of one. readManifest would reject the fragment, but "absent" is the honest
  // state and "present but unreadable" invites someone to try to repair it.
  // PER-PROCESS temp name, never a fixed `<file>.tmp`: a dev instance and the
  // built app share the cache dir, so two writers on one temp path make the
  // loser's rename throw ENOENT (scripts/ast-grep/atomic-tmp-name-per-process).
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, target);
}

/** The manifest for a download, or null. Absent, unreadable, malformed, and
 *  from-a-future-version all answer null — the caller's only question is
 *  "can I resume this?", and every one of those means no. */
export function readManifest(cacheDir: string, firstFileBasename: string): DownloadManifest | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPathFor(cacheDir, firstFileBasename), 'utf8'));
  } catch {
    return null;
  }
  if (raw?.v !== 1) return null;
  if (typeof raw.repo !== 'string' || !raw.repo) return null;
  if (typeof raw.quant !== 'string' || !raw.quant) return null;
  if (!Array.isArray(raw.files) || raw.files.length === 0) return null;
  if (!raw.files.every((f: unknown) => typeof f === 'string')) return null;
  if (typeof raw.totalSizeBytes !== 'number' || !Number.isFinite(raw.totalSizeBytes)) return null;
  if (typeof raw.sha256ByFile !== 'object' || raw.sha256ByFile === null) return null;
  if (typeof raw.startedAt !== 'number') return null;
  return raw as DownloadManifest;
}

export function removeManifest(cacheDir: string, firstFileBasename: string): void {
  fs.rmSync(manifestPathFor(cacheDir, firstFileBasename), { force: true });
  // Sweep any half-written temp too. The name carries the writing process's
  // pid, so it can't be reconstructed — match the prefix instead. A crashed
  // write from ANOTHER process is exactly the litter this is here to clear.
  const prefix = `${firstFileBasename}${MANIFEST_SUFFIX}.`;
  let names: string[] = [];
  try { names = fs.readdirSync(cacheDir); } catch { return; } // dir gone — nothing to sweep
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      fs.rmSync(path.join(cacheDir, name), { force: true });
    }
  }
}
