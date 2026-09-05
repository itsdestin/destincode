// GGUF downloader (spec §4.4): fetches quant file sets from HF resolve URLs
// into the llama.cpp cache dir. Contracts:
//   - files land FLAT under cacheDir with their BASENAME (subfolder paths in
//     the repo are collapsed) — that is what Plan B's cache-scan/router
//     discovery reads; probe-download.mjs pins the equivalence.
//   - in-flight bytes live in <name>.partial; publish is an atomic rename, so
//     a crash/cancel never leaves a half-file the router could try to load.
//   - resume: an existing .partial continues via a Range request.
//   - sha256 (from HF lfs.oid) verifies each part when available; a mismatch
//     deletes the bad bytes and errors — never publishes.
//   - cancel keeps .partial files (resume later); a later delete cleans up.
//   - the manifest sidecar SURVIVES completion, stamped with completedAt — see
//     download-manifest.ts for why a finished model still needs it.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ulid } from 'ulid';
import { hfResolveUrl } from './hf-client';
import { writeManifest, readManifest, markManifestComplete, isManifestComplete } from './download-manifest';
import type { DownloadProgress, QuantOption } from '../../shared/model-manager-types';

const PROGRESS_INTERVAL_MS = 250;

interface ActiveDownload {
  key: string;                       // repo::quant — concurrency guard
  abort: AbortController;
  promise: Promise<void>;
  cancelled: boolean;
}

export class ModelDownloader {
  private active = new Map<string, ActiveDownload>(); // by downloadId

  constructor(private cacheDir: string, private fetchImpl: typeof fetch = fetch) {}

  /** Kick off a download; progress arrives via onProgress; await wait(id) for
   *  the outcome. Throws synchronously if this repo+quant is already running. */
  start(repo: string, quant: QuantOption, onProgress: (p: DownloadProgress) => void): string {
    const key = `${repo}::${quant.quant}`;
    for (const d of this.active.values()) {
      if (d.key === key) throw new Error('That model is already downloading.');
    }
    const firstFile = path.basename(quant.files[0]);
    // The manifest is what makes this download resumable after a crash — write
    // it BEFORE any bytes, so a crash one second from now still leaves a trail.
    // mkdir here (not only in run()) because the manifest lands in the same dir.
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const prior = readManifest(this.cacheDir, firstFile);
    // WHY isManifestComplete: a manifest now stays behind after the download
    // finishes, and a FINISHED download is not "partly downloaded" — only an
    // unstamped manifest means there are half-fetched bytes on disk to protect.
    // prior.repo === null is an untraceable record (§E3's "not found" marker),
    // never a rival publisher — it must not block anything.
    if (prior && !isManifestComplete(prior) && prior.repo !== null && prior.repo !== repo) {
      // Same filename, different publisher: the .partial on disk holds ANOTHER
      // build's bytes, and Range-continuing it would fail the integrity check
      // only after the whole remainder was fetched. The prior download has a
      // row in Local Models (its manifest alone makes one), so the user can
      // delete it there.
      throw new Error(
        `${firstFile} is already partly downloaded from ${prior.repo}. `
        + `Delete that download in Local Models before downloading it from ${repo}.`
      );
    }
    writeManifest(this.cacheDir, repo, quant, Date.now());

    const downloadId = ulid();
    const abort = new AbortController();
    const entry: ActiveDownload = {
      key, abort, cancelled: false, promise: Promise.resolve(),
    };
    entry.promise = this.run(downloadId, repo, quant, entry, onProgress)
      .finally(() => { /* keep the entry until wait() consumers observe it */ });
    this.active.set(downloadId, entry);
    return downloadId;
  }

  async wait(downloadId: string): Promise<void> {
    const entry = this.active.get(downloadId);
    if (!entry) return;
    try { await entry.promise; } finally { this.active.delete(downloadId); }
  }

  cancel(downloadId: string): void {
    const entry = this.active.get(downloadId);
    if (!entry) return;
    entry.cancelled = true;
    entry.abort.abort();
  }


  private async run(
    downloadId: string, repo: string, quant: QuantOption,
    entry: ActiveDownload, onProgress: (p: DownloadProgress) => void
  ): Promise<void> {
    const parts = quant.files.length;
    const base: Omit<DownloadProgress, 'state' | 'receivedBytes' | 'currentPart'> = {
      downloadId, repo, quant: quant.quant, totalBytes: quant.totalSizeBytes, parts,
    };
    let doneBytes = 0; // completed parts
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      for (let i = 0; i < quant.files.length; i++) {
        const filePath = quant.files[i];
        const fileName = path.basename(filePath);
        const finalPath = path.join(this.cacheDir, fileName);
        const partialPath = `${finalPath}.partial`;
        if (fs.existsSync(finalPath)) { // already installed (re-download after partial delete)
          doneBytes += fs.statSync(finalPath).size;
          continue;
        }
        const emit = (received: number, state: DownloadProgress['state'] = 'downloading') =>
          onProgress({ ...base, state, receivedBytes: doneBytes + received, currentPart: i + 1 });

        const received = await this.downloadFile(
          hfResolveUrl(repo, filePath), partialPath, entry.abort.signal, emit
        );

        const expected = quant.sha256ByFile[filePath];
        if (expected) {
          emit(received, 'verifying');
          const actual = await sha256File(partialPath);
          if (actual !== expected) {
            fs.rmSync(partialPath, { force: true });
            throw new Error(`${fileName} failed its integrity check — the download was corrupted. Please try again.`);
          }
        }
        // Publish atomically — the router only ever sees whole files.
        fs.renameSync(partialPath, finalPath);
        doneBytes += received;
      }
      // Clean completion of the WHOLE set. The manifest is STAMPED, not deleted:
      // the finished model still needs its repo and its vision projector, and
      // `completedAt` is what tells every reader this is a record rather than an
      // interrupted download. Deliberately NOT in a finally: cancel and error
      // must leave it unstamped, because that is exactly when the user will
      // want to resume.
      markManifestComplete(this.cacheDir, path.basename(quant.files[0]), Date.now());
      onProgress({ ...base, state: 'done', receivedBytes: doneBytes, currentPart: parts });
    } catch (e: any) {
      if (entry.cancelled) {
        onProgress({ ...base, state: 'cancelled', receivedBytes: doneBytes, currentPart: parts });
        throw new Error('Download cancelled.');
      }
      onProgress({ ...base, state: 'error', receivedBytes: doneBytes, currentPart: parts, message: e?.message ?? String(e) });
      throw e;
    }
  }

  /** One file → .partial with Range resume. Returns total bytes of the file. */
  private async downloadFile(
    url: string, partialPath: string, signal: AbortSignal,
    emit: (receivedInFile: number) => void
  ): Promise<number> {
    let start = 0;
    try { start = fs.statSync(partialPath).size; } catch { /* fresh */ }
    const res = await this.fetchImpl(url, {
      signal,
      headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
    });
    if (res.status === 416) { fs.rmSync(partialPath, { force: true }); return this.downloadFile(url, partialPath, signal, emit); }
    if (!res.ok && res.status !== 206) throw new Error(`Hugging Face responded with HTTP ${res.status}.`);
    if (start > 0 && res.status !== 206) { fs.rmSync(partialPath, { force: true }); start = 0; } // Range ignored → restart
    if (!res.body) throw new Error('Empty download response.');
    const ws = fs.createWriteStream(partialPath, { flags: start > 0 ? 'a' : 'w' });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let received = start;
    let lastEmit = 0;
    try {
      for (;;) {
        // K3: don't rely SOLELY on fetch honoring the signal — check each turn
        // so a cancel always breaks the loop (and reject the in-flight read).
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        await new Promise<void>((resolve, reject) => ws.write(value, (err) => (err ? reject(err) : resolve())));
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) { lastEmit = now; emit(received); }
      }
      emit(received);
      return received;
    } finally {
      await new Promise<void>((resolve) => ws.end(() => resolve()));
    }
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
