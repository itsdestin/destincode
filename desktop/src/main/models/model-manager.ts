// ModelManager — composition root for the models:* IPC surface. Thin: real
// logic lives in the pure/unit-tested modules; this class only wires them to
// the EngineManager's cache dir and fans progress out as events.
import { EventEmitter } from 'events';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { NativeHome } from '../native-home';
import { EngineManager } from '../engine/engine-manager';
import { readEngineConfig } from '../engine/engine-config';
import { readManifest } from './download-manifest';
import { CuratedCatalog } from './curated-catalog';
import { HfClient } from './hf-client';
import { ModelDownloader } from './model-downloader';
import { estimateFit, checkDiskSpace, checkMemoryForLoad, type MemoryVerdict } from './fit-estimator';
import { detectGpu } from './gpu-detector';
import type {
  CuratedModel, DownloadProgress, FitEstimate, HFSearchHit, QuantOption,
} from '../../shared/model-manager-types';

export class ModelManager extends EventEmitter {
  private curated: CuratedCatalog;
  private hf: HfClient;
  private downloader: ModelDownloader | null = null; // rebuilt if cacheDir changes

  constructor(
    private home: NativeHome,
    private engine: EngineManager,
    userDataDir: string,
    // totalVramBytes lets tests pin GPU-aware fit; undefined = detect at runtime,
    // null = force RAM-only (Amendment 2026-07-14 F).
    private opts: { fetchImpl?: typeof fetch; totalMemBytes?: number; totalVramBytes?: number | null } = {}
  ) {
    super();
    this.curated = new CuratedCatalog(userDataDir, opts.fetchImpl as any);
    this.hf = new HfClient(opts.fetchImpl as any);
  }

  private cacheDir(): string { return readEngineConfig(this.home).cacheDir; }

  private getDownloader(): ModelDownloader {
    // cacheDir can change (Plan C panel shows it; later phases may make it
    // editable) — cheap to rebuild per call chain when it does.
    if (!this.downloader || (this.downloader as any).cacheDir !== this.cacheDir()) {
      this.downloader = new ModelDownloader(this.cacheDir(), this.opts.fetchImpl);
    }
    return this.downloader;
  }

  // Detected VRAM, cached once (undefined = not yet probed). Injected value in
  // opts wins so tests are deterministic. GPU-aware fit — Amendment 2026-07-14 F.
  private vramCache: number | null | undefined = undefined;
  private async vram(): Promise<number | null> {
    if (this.opts.totalVramBytes !== undefined) return this.opts.totalVramBytes;
    if (this.vramCache === undefined) this.vramCache = (await detectGpu()).totalVramBytes;
    return this.vramCache;
  }
  private fitFor(sizeBytes: number, vram: number | null): FitEstimate {
    return estimateFit(sizeBytes, this.opts.totalMemBytes ?? os.totalmem(), vram);
  }

  /** Curated RECOMMENDATIONS — plain list, no baked sizes (Amendment D). The
   *  panel fetches each card's default-quant size + fit via quants(hfRepo). */
  curatedList(): Promise<CuratedModel[]> { return this.curated.get(); }

  search(query: string): Promise<HFSearchHit[]> { return this.hf.search(query); }

  /** Each quant variant decorated with a GPU-aware fit label. This is also the
   *  call the panel uses to size + fit a curated card (find the quantDefault). */
  async quants(repo: string): Promise<Array<QuantOption & { fit: FitEstimate }>> {
    const [opts, vram] = await Promise.all([this.hf.quantOptions(repo), this.vram()]);
    return opts.map((o) => ({ ...o, fit: this.fitFor(o.totalSizeBytes, vram) }));
  }

  /** Create-time / swap-time memory guard for an INSTALLED model id: is it safe
   *  to load it given what's already resident? Blocks only when clearly too
   *  large; otherwise warns (see checkMemoryForLoad). Unknown model/size → 'ok'
   *  (never block on missing data). Used by the new-session picker + swap popup. */
  async memoryCheck(modelId: string): Promise<MemoryVerdict> {
    const [models, vram] = await Promise.all([this.engine.liveModels(), this.vram()]);
    const chosen = models.find((m) => m.id === modelId);
    const chosenBytes = chosen?.sizeBytes ?? 0;
    if (chosenBytes <= 0) return { verdict: 'ok', headline: '', detail: '' };
    const loadedBytes = models
      .filter((m) => m.id !== modelId && (m.state === 'loaded' || m.state === 'loading'))
      .reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
    return checkMemoryForLoad({
      chosenBytes,
      totalMemBytes: this.opts.totalMemBytes ?? os.totalmem(),
      totalVramBytes: vram,
      loadedBytes,
    });
  }

  /** Free bytes on the volume holding `dir`, walking UP to the nearest EXISTING
   *  ancestor when the cache dir doesn't exist yet (Amendment 2026-07-14 J — the
   *  old code skipped the guard entirely on a fresh cache dir). null = couldn't
   *  determine (guard skipped). */
  private freeBytesNear(dir: string): number | null {
    let d = dir;
    for (let i = 0; i < 40; i++) {
      try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { /* try parent */ }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return null;
  }

  // Remaining bytes of in-flight downloads (K5): the disk guard reserves them so
  // two large downloads can't each pass against the same free space and then
  // collectively overflow the disk.
  private inflight = new Map<string, { total: number; received: number }>();
  private reservedBytes(): number {
    let sum = 0;
    for (const d of this.inflight.values()) sum += Math.max(0, d.total - d.received);
    return sum;
  }

  /** Bytes of THIS download's file set already on disk — published parts plus
   *  the .partial. Feeds the disk guard so a resume is judged on what is left. */
  private bytesOnDiskFor(quant: QuantOption): number {
    const dir = this.cacheDir();
    let sum = 0;
    for (const filePath of quant.files) {
      const base = path.basename(filePath);
      for (const candidate of [base, `${base}.partial`]) {
        try { sum += fs.statSync(path.join(dir, candidate)).size; } catch { /* absent */ }
      }
    }
    return sum;
  }

  /** Disk guard (reserving in-flight downloads and crediting bytes already
   *  fetched), then start; progress fans out on 'download-progress'. */
  async download(repo: string, quant: QuantOption): Promise<{ downloadId: string }> {
    const free = this.freeBytesNear(this.cacheDir());
    if (free != null) {
      const refusal = checkDiskSpace(
        quant.totalSizeBytes,
        Math.max(0, free - this.reservedBytes()),
        this.bytesOnDiskFor(quant),
      );
      if (refusal) throw new Error(refusal);
    }
    const dl = this.getDownloader();
    const downloadId = dl.start(repo, quant, (p: DownloadProgress) => {
      this.inflight.set(downloadId, { total: p.totalBytes, received: p.receivedBytes });
      this.emit('download-progress', p);
    });
    // Outcome is delivered via progress events; swallow the rejection here so an
    // error can't become an unhandled rejection in main (the UI reads the
    // 'error' progress event). Clear the reservation once the download settles.
    void dl.wait(downloadId).catch(() => {}).finally(() => this.inflight.delete(downloadId));
    return { downloadId };
  }

  cancel(downloadId: string): void { this.getDownloader().cancel(downloadId); }

  /** Continue an interrupted download from the manifest beside it. Deliberately
   *  no network: the interruption that stranded the download is often the
   *  network itself. The downloader skips published parts and Range-continues
   *  the .partial, so this is the original download(repo, quant) call replayed. */
  async resume(modelId: string): Promise<{ downloadId: string }> {
    const manifest = readManifest(this.cacheDir(), `${modelId}.gguf`);
    if (!manifest) {
      // Specific and accurate, per docs/error-message-standards.md — this names
      // the real cause and what the user can do instead. The UI never offers
      // Resume on such a row; this guards the IPC and remote surfaces.
      throw new Error(
        "This download has no record of where it came from, so it can't be resumed automatically. "
        + 'Find the model in search and download it again — it will continue from where it stopped.'
      );
    }
    return this.download(manifest.repo, {
      quant: manifest.quant,
      description: '',
      files: manifest.files,
      totalSizeBytes: manifest.totalSizeBytes,
      sha256ByFile: manifest.sha256ByFile,
    });
  }
}
