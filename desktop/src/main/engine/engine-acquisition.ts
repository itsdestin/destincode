// Engine acquisition (spec §3.1): download the pinned llama.cpp release asset,
// SHA-256-verify against engine-pin.ts, unpack into userData/engine/
// <version>-<backend>/. The invariant: NEVER leave a half-unpacked dir marked
// usable — unpack goes into a `.unpacking` sibling, the `.complete` marker is
// written INSIDE it last, and only then is it renamed into place.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { EngineAsset } from './engine-pin';
import { ENGINE_VERSION, assetUrl } from './engine-pin';
import type { EngineBackend, EngineInstallProgress } from '../../shared/engine-types';

const execFileAsync = promisify(execFile);
// Progress events throttled so a fast download doesn't flood IPC.
const PROGRESS_INTERVAL_MS = 250;

// On Windows, `tar` MUST be the System32 bsdtar (libarchive): it reads BOTH the
// .zip Windows engine builds AND .tar.gz. A bare `tar` on PATH can resolve to
// Git's GNU tar, which CANNOT read zip and fails the unpack. Verified 2026-07-13.
function systemTar(): string {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

/** One compute device the pinned binary reports for THIS build, read straight
 *  off `llama-server --list-devices` and frozen into the `.complete` marker at
 *  install time (design §A2). Later code — the memory estimator, the engine
 *  card's device line — asks the marker how much graphics memory this machine
 *  has instead of spawning the engine again. */
export interface EngineDevice {
  /** The engine's OWN device id, exactly as it prints it: `Vulkan0`, `CUDA0`,
   *  `ROCm0`, `Metal0`. Kept verbatim because it is both the token `--device`
   *  accepts and the prefix the post-install check matches on (design §A4). */
  backend: string;
  name: string;
  /** As the engine reports them. **null means "not measured"** — a device line
   *  in a shape this parser does not recognise keeps its name and loses its
   *  numbers, rather than being recorded as a 0 MiB pool. A zero would read
   *  downstream as "this graphics chip has no memory", which is a claim we
   *  never made. */
  totalMiB: number | null;
  freeMiB: number | null;
  /** False for software renderers. llvmpipe and SwiftShader are the CPU
   *  pretending to be a graphics card: on this machine llvmpipe reports
   *  124406 MiB of "VRAM", which is simply system RAM. Counting one as a GPU
   *  would tell the user their model is running on hardware acceleration while
   *  every token is actually being computed by the processor — and would hand
   *  the memory estimator a 121 GB pool that does not exist. */
  isGpu: boolean;
}

/** What pressing Install will actually pull, per archive and in total. */
export interface EngineDownloadSize {
  /** Sum over every archive, or **null when any part's size is unknown** — a
   *  partial sum presented as a whole is worse than saying nothing. */
  totalBytes: number | null;
  parts: { assetName: string; bytes: number | null }[];
}

export interface InstalledEngine {
  version: string;
  backend: EngineBackend;
  binaryPath: string;   // absolute path to llama-server(.exe)
  dir: string;
  /** From the marker. `undefined` = this install predates the device list and
   *  has not been backfilled yet; `[]` = the engine reports no GPU at all. */
  devices?: EngineDevice[];
  /** Why the device list is unknown, in the engine's own words. Set when
   *  `--list-devices` could not be run or read; `devices` is then `[]`, and the
   *  pair says "we don't know", never "there is nothing here". */
  devicesError?: string;
}

interface CompleteMarker {
  version: string;
  backend: EngineBackend;
  binaryRelPath: string;
  devices?: EngineDevice[];
  devicesError?: string;
}

// `--list-devices` costs ~70 ms on this machine (measured, b10665 Vulkan). The
// cap is for the pathological case — a wedged GPU driver blocking on device
// enumeration — where hanging the install (or, for the lazy backfill, leaking a
// stuck process on every status read) is the real failure.
const LIST_DEVICES_TIMEOUT_MS = 15_000;

export class EngineAcquisition {
  /** Installs whose device list we have already tried to backfill this process
   *  — success OR failure. WHY it records failures too: `installed()` is called
   *  from `status()`, which runs on every engine event, so a binary that cannot
   *  answer `--list-devices` would otherwise be re-spawned dozens of times a
   *  minute. It also makes the backfill single-flight: two callers racing
   *  `status()` find the dir already claimed and only one process is spawned. */
  private devicesBackfilled = new Set<string>();

  /** engineRoot = <userData>/engine — per-machine, never synced (Phase 0 §1). */
  constructor(
    private engineRoot: string,
    private fetchImpl: typeof fetch = fetch,
    /** Called after a lazy backfill rewrites a marker. The backfill cannot block
     *  `status()` (it is synchronous and this spawns a process), so the fresh
     *  device list lands a moment later — this is how the caller learns to
     *  re-read it instead of showing "Processor only" until the next unrelated
     *  engine event. */
    private onMarkerUpdated?: () => void,
  ) {}

  installDir(version: string, backend: EngineBackend): string {
    return path.join(this.engineRoot, `${version}-${backend}`);
  }

  /** Newest USABLE install: a dir with a .complete marker whose binary exists.
   *  Prefers the pinned version so an old engine keeps serving while a pin
   *  bump downloads the new one. Within the pinned version, prefers
   *  preferBackend: after a Vulkan→CPU fallback the config records the backend
   *  that actually BOOTED, and the leftover (installed-but-non-booting) Vulkan
   *  dir still carries a valid .complete marker — without this preference it
   *  could shadow the working CPU build and re-enter the crash loop. */
  installed(preferBackend?: EngineBackend): InstalledEngine | null {
    let entries: string[] = [];
    try { entries = fs.readdirSync(this.engineRoot); } catch { return null; }
    const found: InstalledEngine[] = [];
    for (const name of entries) {
      const dir = path.join(this.engineRoot, name);
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')) as CompleteMarker;
        const binaryPath = path.join(dir, marker.binaryRelPath);
        if (fs.existsSync(binaryPath)) {
          found.push({
            version: marker.version, backend: marker.backend, binaryPath, dir,
            devices: marker.devices, devicesError: marker.devicesError,
          });
        }
      } catch { /* no marker / unreadable → not a usable install; skip */ }
    }
    const pinned = found.filter((f) => f.version === ENGINE_VERSION);
    let chosen: InstalledEngine | null = null;
    if (preferBackend) chosen = pinned.find((f) => f.backend === preferBackend) ?? null;
    chosen ??= pinned[0] ?? found[0] ?? null;
    // An engine installed before this feature existed has no device list in its
    // marker, so the memory estimator would have nothing to size a model
    // against. Fill it in from the binary that is already on disk, once, in the
    // background — never on the first install path (install() writes it before
    // the directory is even renamed into place). Fire-and-forget on purpose:
    // this method is called from the synchronous status() and must not spawn a
    // process the caller has to wait on.
    if (chosen && chosen.devices === undefined) void this.backfillDevices(chosen);
    return chosen;
  }

  /** One-shot lazy fill of a pre-feature marker's device list. Rewrites the
   *  marker in place (temp file + rename, so a crash mid-write cannot leave a
   *  marker that `installed()` can no longer parse — which would make a working
   *  engine look uninstalled). Never throws: a failure records the engine's own
   *  words in `devicesError` and stops there. */
  private async backfillDevices(install: InstalledEngine): Promise<void> {
    if (this.devicesBackfilled.has(install.dir)) return;
    this.devicesBackfilled.add(install.dir);
    const probed = await listDevices(install.binaryPath);
    try {
      const markerPath = path.join(install.dir, '.complete');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as CompleteMarker;
      // Re-check under the read: another process (the built app alongside a dev
      // instance shares nothing here, but a second install can) may have filled
      // it already, and its list came from the same binary.
      if (marker.devices !== undefined) return;
      marker.devices = probed.devices;
      if (probed.error) marker.devicesError = probed.error;
      // Per-process temp name: the built app and a dev instance can hold the
      // same engine directory, and two of them racing one fixed `<file>.tmp`
      // makes the loser's rename throw ENOENT over a half-written marker.
      const tmp = `${markerPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(marker));
      fs.renameSync(tmp, markerPath);
    } catch { return; /* unreadable/unwritable marker → leave it alone */ }
    this.onMarkerUpdated?.();
  }

  /** Remove one install from disk. Called when a freshly-installed engine turns
   *  out not to BOOT on this machine.
   *
   *  WHY this has to exist: `install()` writes the `.complete` marker and renames
   *  the directory into place BEFORE anything runs the binary, and `installed()`
   *  prefers the pinned version over every other. So an engine that downloads and
   *  unpacks perfectly but will not start (old GPU driver, unusual distro) SHADOWS
   *  a working older install and takes local models down with it. That was survivable
   *  while the only route in was a user pressing Install and reading the error; the
   *  launch auto-update makes it unattended, so the failed install has to be undone.
   *  Returns false if the directory could not be removed (a caller may still be
   *  holding the binary open) — the caller decides whether that is fatal. */
  discard(installed: InstalledEngine): boolean {
    try {
      fs.rmSync(installed.dir, { recursive: true, force: true });
      return !fs.existsSync(installed.dir);
    } catch {
      return false;
    }
  }

  /** Delete every install that is not `keep`. Called only AFTER a replacement has
   *  proven it boots — `installed()` already prefers the pinned version, so an
   *  older engine left behind is dead weight (100-500 MB unpacked) rather than a
   *  usable fallback. Best-effort: a dir that will not delete is skipped, never
   *  thrown, because failing to reclaim disk must not fail an engine update. */
  pruneOthers(keep: InstalledEngine): void {
    let entries: string[] = [];
    try { entries = fs.readdirSync(this.engineRoot); } catch { return; }
    for (const name of entries) {
      const dir = path.join(this.engineRoot, name);
      if (dir === keep.dir) continue;
      // Only touch directories that ARE installs (they carry a .complete marker).
      // Never blind-delete siblings — the engine root also holds `.download`
      // archives and `.unpacking` scratch that install() manages itself.
      if (!fs.existsSync(path.join(dir, '.complete'))) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  /** How many bytes pressing Install will really pull: the engine archive PLUS
   *  the separate runtime archive some backends need, asked of the server
   *  BEFORE the first byte is downloaded.
   *
   *  WHY it exists and why it must be known up front: at the pinned b10665 the
   *  Windows CUDA switch is a 238 MB engine and a 373 MB CUDA runtime — 611 MB
   *  against the 32 MB Vulkan default, nineteen times larger; Linux ROCm is
   *  204 MB, about seven times. A progress bar that opens at "of 238 MB" and
   *  silently doubles partway, or a confirmation that never says the number at
   *  all, is a 611 MB surprise on someone's metered connection. Callers show
   *  this before asking the user to commit, and `install()` uses the same sum
   *  so the bar and the warning agree.
   *
   *  `totalBytes` is null when ANY part's size could not be read (a proxy that
   *  drops Content-Length, an offline machine). Null says "we don't know" — a
   *  partial sum shown as a whole would understate the download. */
  async probeDownloadSize(asset: EngineAsset): Promise<EngineDownloadSize> {
    const wanted = [asset.assetName, ...(asset.runtime ? [asset.runtime.assetName] : [])];
    const parts: { assetName: string; bytes: number | null }[] = [];
    for (const assetName of wanted) {
      parts.push({ assetName, bytes: await this.headContentLength(assetUrl({ ...asset, assetName })) });
    }
    const totalBytes = parts.every((p) => p.bytes !== null)
      ? parts.reduce((sum, p) => sum + (p.bytes ?? 0), 0)
      : null;
    return { totalBytes, parts };
  }

  async install(asset: EngineAsset, onProgress: (p: EngineInstallProgress) => void): Promise<InstalledEngine> {
    const finalDir = this.installDir(ENGINE_VERSION, asset.backend);
    // Idempotent: an already-usable install of this exact version+backend is
    // returned as-is (the panel's Install button can be pressed twice).
    const existingMarker = path.join(finalDir, '.complete');
    if (fs.existsSync(existingMarker)) {
      try {
        const m = JSON.parse(fs.readFileSync(existingMarker, 'utf8')) as CompleteMarker;
        const bin = path.join(finalDir, m.binaryRelPath);
        if (fs.existsSync(bin)) {
          const already: InstalledEngine = {
            version: ENGINE_VERSION, backend: asset.backend, binaryPath: bin, dir: finalDir,
            devices: m.devices, devicesError: m.devicesError,
          };
          // Pressing Install on the build you already run must still leave a
          // device list behind: the post-install check (design §A4) reads the
          // marker either way, and waiting here is free — the user is already
          // sitting in front of an install.
          if (already.devices === undefined) {
            await this.backfillDevices(already);
            const refreshed = this.readMarker(finalDir);
            already.devices = refreshed?.devices;
            already.devicesError = refreshed?.devicesError;
          }
          onProgress({ kind: 'done', version: ENGINE_VERSION, backend: asset.backend });
          return already;
        }
      } catch { /* corrupt marker → reinstall below */ }
    }

    fs.mkdirSync(this.engineRoot, { recursive: true });
    const archivePath = path.join(this.engineRoot, `${asset.assetName}.download`);
    const runtimePath = asset.runtime
      ? path.join(this.engineRoot, `${asset.runtime.assetName}.download`)
      : null;
    try {
      // Both sizes first, so the ONE progress stream can quote the real total
      // from its very first event rather than discovering the second archive
      // halfway through. See probeDownloadSize().
      const planned = await this.probeDownloadSize(asset);
      onProgress({ kind: 'download', receivedBytes: 0, totalBytes: planned.totalBytes });

      await this.download(assetUrl(asset), archivePath, onProgress, 0, planned.totalBytes);

      onProgress({ kind: 'verify' });
      const hash = await sha256File(archivePath);
      if (hash !== asset.sha256) {
        fs.rmSync(archivePath, { force: true });
        throw new Error('The downloaded engine failed its integrity check — please try installing again.');
      }

      if (asset.runtime && runtimePath) {
        // The second archive continues the SAME stream: its bytes are offset by
        // the engine archive already on disk, so the bar keeps climbing instead
        // of snapping back to zero for a second download the user was never
        // told about.
        const already = fs.statSync(archivePath).size;
        await this.download(
          assetUrl({ ...asset, assetName: asset.runtime.assetName }),
          runtimePath, onProgress, already, planned.totalBytes,
        );
        onProgress({ kind: 'verify' });
        const runtimeHash = await sha256File(runtimePath);
        if (runtimeHash !== asset.runtime.sha256) {
          // Both scratch files go, not just the corrupt one. The two archives
          // are a matched set — half a CUDA install is not a thing to resume —
          // and download() restarts from zero when it finds a COMPLETE file
          // anyway (a Range request past the end answers 416), so keeping the
          // engine archive would leave hundreds of MB on disk that the retry
          // re-downloads regardless.
          fs.rmSync(runtimePath, { force: true });
          fs.rmSync(archivePath, { force: true });
          throw new Error(
            `The ${asset.backend.toUpperCase()} runtime files failed their integrity check — please try installing again.`
          );
        }
      }

      onProgress({ kind: 'unpack' });
      const partialDir = `${finalDir}.unpacking`;
      fs.rmSync(partialDir, { recursive: true, force: true });
      fs.mkdirSync(partialDir, { recursive: true });
      // System bsdtar handles BOTH shapes: .zip (Windows builds) and .tar.gz —
      // no unzip dependency to bundle. See systemTar() for the Windows caveat.
      await execFileAsync(systemTar(), ['-xf', archivePath, '-C', partialDir]);
      // The runtime unpacks into the SAME directory, not a sibling: those DLLs
      // are what the engine loads at start-up, and Windows searches the folder
      // the .exe lives in. Anywhere else and the CUDA build dies at load on a
      // PC without the toolkit installed.
      if (runtimePath) await execFileAsync(systemTar(), ['-xf', runtimePath, '-C', partialDir]);

      const binaryPath = path.join(partialDir, asset.binaryRelPath);
      if (!fs.existsSync(binaryPath)) {
        throw new Error(
          `The engine archive did not contain ${asset.binaryRelPath} — the pinned layout in engine-pin.ts is stale.`
        );
      }
      if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755);

      // Ask the freshly-unpacked binary what it can actually run on, BEFORE the
      // directory is renamed into place. Two reasons it happens here and for
      // every backend, not just the new ones: the answer is what later tells the
      // user how much graphics memory a model has to fit into, and running it
      // now means the marker is complete the instant the install becomes
      // visible — never a window where an install exists with no pool. A probe
      // that fails does NOT fail the install (the engine may still boot fine);
      // it records the engine's own words instead.
      const probed = await listDevices(binaryPath);

      // Marker LAST, then atomic rename into place — the only two orders that
      // can crash mid-way both leave either no finalDir or a fully-usable one.
      // (Killed between the probe and the rename is the same as killed during
      // the unpack: `.unpacking` is scrubbed in the finally below and finalDir
      // was never touched.)
      const marker: CompleteMarker = {
        version: ENGINE_VERSION, backend: asset.backend, binaryRelPath: asset.binaryRelPath,
        devices: probed.devices,
        ...(probed.error ? { devicesError: probed.error } : {}),
      };
      fs.writeFileSync(path.join(partialDir, '.complete'), JSON.stringify(marker));
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(partialDir, finalDir);
      fs.rmSync(archivePath, { force: true });
      if (runtimePath) fs.rmSync(runtimePath, { force: true });

      onProgress({ kind: 'done', version: ENGINE_VERSION, backend: asset.backend });
      return {
        version: ENGINE_VERSION, backend: asset.backend,
        binaryPath: path.join(finalDir, asset.binaryRelPath), dir: finalDir,
        devices: marker.devices, devicesError: marker.devicesError,
      };
    } catch (e: any) {
      onProgress({ kind: 'error', message: e?.message ?? String(e) });
      throw e;
    } finally {
      fs.rmSync(`${finalDir}.unpacking`, { recursive: true, force: true });
    }
  }

  private readMarker(dir: string): CompleteMarker | null {
    try { return JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')) as CompleteMarker; }
    catch { return null; }
  }

  /** Content-Length via HEAD. Null on any failure — the caller turns that into
   *  "size unknown", never into a zero or a guess. */
  private async headContentLength(url: string): Promise<number | null> {
    try {
      const res = await this.fetchImpl(url, { method: 'HEAD' });
      // Some servers answer HEAD with a body; release it or the socket leaks.
      await res.body?.cancel().catch(() => {});
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length'));
      return Number.isFinite(len) && len > 0 ? len : null;
    } catch { return null; }
  }

  /** Streaming download with Range-based resume. GitHub release assets are
   *  redirect-served (Node fetch follows) and support Range requests.
   *
   *  `offsetBytes` = bytes of the SAME install already downloaded in an earlier
   *  archive, and `plannedTotal` = the summed size of every archive, so two
   *  downloads report as one continuous stream. `plannedTotal` null (a size we
   *  could not read) falls back to this archive's own Content-Length plus the
   *  offset — the bar then still only ever moves forwards, it just doesn't know
   *  the finish line until the last archive starts. */
  private async download(
    url: string, dest: string, onProgress: (p: EngineInstallProgress) => void,
    offsetBytes = 0, plannedTotal: number | null = null,
  ): Promise<void> {
    let start = 0;
    try { start = fs.statSync(dest).size; } catch { /* no partial */ }

    const res = await this.fetchImpl(url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
    });
    if (res.status === 416) {
      fs.rmSync(dest, { force: true });
      return this.download(url, dest, onProgress, offsetBytes, plannedTotal);
    }
    if (!res.ok && res.status !== 206) {
      throw new Error(`Engine download failed: the server responded with HTTP ${res.status}.`);
    }
    if (start > 0 && res.status !== 206) {
      fs.rmSync(dest, { force: true });
      start = 0;
    }
    if (!res.body) throw new Error('Engine download failed: empty response.');

    const lenHeader = res.headers.get('content-length');
    const ownTotal = lenHeader ? Number(lenHeader) + start : null;
    const totalBytes = plannedTotal ?? (ownTotal === null ? null : ownTotal + offsetBytes);
    const ws = fs.createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' });
    // A write-stream 'error' emitted OUTSIDE a pending write callback (disk
    // full, EACCES, an async flush during end()) is otherwise unhandled — and
    // an unhandled stream 'error' crashes the Electron main process. Capture it
    // and surface it as a normal rejected install instead. Engine archives are
    // hundreds of MB, so disk-full mid-download is a real path.
    let streamError: Error | null = null;
    ws.on('error', (e: Error) => { streamError = e; });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let received = start;
    let lastEmit = 0;
    try {
      for (;;) {
        if (streamError) throw streamError;
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        await new Promise<void>((resolve, reject) => {
          ws.write(value, (err) => (err ? reject(err) : resolve()));
        });
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now;
          onProgress({ kind: 'download', receivedBytes: offsetBytes + received, totalBytes });
        }
      }
      onProgress({ kind: 'download', receivedBytes: offsetBytes + received, totalBytes });
    } finally {
      await reader.cancel().catch(() => {}); // release the response body on any exit path
      await new Promise<void>((resolve) => ws.end(() => resolve()));
    }
    // A flush error surfacing only at end() must fail the install, not pass silently.
    if (streamError) throw streamError;
  }
}

// Software renderers: Mesa's Vulkan-on-CPU driver reports itself as
// "llvmpipe (LLVM 22.1.6, 256 bits)", Google's as "SwiftShader Device". Matched
// on the NAME because that is all the engine gives us — both announce
// themselves through the Vulkan backend exactly like a real card does.
const SOFTWARE_RENDERERS = ['llvmpipe', 'swiftshader'];

// `  Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)`
// The name is lazy and the memory group is anchored to end-of-line, so a name
// that contains its OWN parentheses (every RADV device does) is not truncated.
const DEVICE_LINE = /^\s+(\S+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;
// Fallback for a device line in an unrecognised shape: keep the id and the name
// honestly, drop the numbers rather than invent them.
const DEVICE_LINE_LOOSE = /^\s+(\S+):\s*(\S.*?)\s*$/;

/** Parse `llama-server --list-devices`. Returns null when the output is not a
 *  device listing at all (an error, a usage dump, an empty stream) — which is a
 *  DIFFERENT answer from "there are no devices" and must not be flattened into
 *  one. Verified against the real b10665 binary on 2026-09-05:
 *
 *      Available devices:
 *        Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)
 *
 *  and, with only the software driver visible,
 *
 *      Available devices:
 *        Vulkan0: llvmpipe (LLVM 22.1.6, 256 bits) (124406 MiB, 80267 MiB free)
 *
 *  and, with none at all (which is also what a CPU-only build prints),
 *
 *      Available devices:
 *        (none)
 */
export function parseDeviceList(output: string): EngineDevice[] | null {
  const lines = output.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /^Available devices:\s*$/.test(l));
  if (headerAt === -1) return null;
  const devices: EngineDevice[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) continue;
    // `  (none)` carries no colon, so neither pattern claims it — the empty
    // list it implies is exactly what we return.
    const m = DEVICE_LINE.exec(line);
    if (m) {
      devices.push({
        backend: m[1], name: m[2],
        totalMiB: Number(m[3]), freeMiB: Number(m[4]),
        isGpu: isGpuDeviceName(m[2]),
      });
      continue;
    }
    const loose = DEVICE_LINE_LOOSE.exec(line);
    if (loose) {
      devices.push({
        backend: loose[1], name: loose[2], totalMiB: null, freeMiB: null,
        isGpu: isGpuDeviceName(loose[2]),
      });
    }
  }
  return devices;
}

/** A software renderer is the processor wearing a graphics card's name. */
export function isGpuDeviceName(name: string): boolean {
  const lower = name.toLowerCase();
  return !SOFTWARE_RENDERERS.some((sw) => lower.includes(sw));
}

/** The first device that is really a graphics chip — what "how much VRAM is
 *  there?" and the engine card's device line both mean. Null when the machine
 *  has none, or when the only ones it has never reported their memory. */
export function firstGpuDevice(devices: EngineDevice[] | undefined): EngineDevice | null {
  return devices?.find((d) => d.isGpu) ?? null;
}

/** Run the unpacked binary's `--list-devices` and read the block back.
 *  Never throws — every failure comes back as `{ devices: [], error }` carrying
 *  the engine's own words, so nothing downstream has to guess why the list is
 *  empty and nothing invents a number to fill the gap. */
async function listDevices(
  binaryPath: string,
): Promise<{ devices: EngineDevice[]; error?: string }> {
  let stdout = '';
  let stderr = '';
  try {
    // cwd = the binary's own folder so it finds the libraries and DLLs unpacked
    // beside it (the Windows CUDA runtime lands there).
    const r = await execFileAsync(binaryPath, ['--list-devices'], {
      timeout: LIST_DEVICES_TIMEOUT_MS,
      cwd: path.dirname(binaryPath),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e: any) {
    // A non-zero exit or a timeout still often prints the block first; take it
    // if it is there, and otherwise report what actually went wrong verbatim.
    stdout = String(e?.stdout ?? '');
    stderr = String(e?.stderr ?? '');
    const parsed = parseDeviceList(stdout);
    if (parsed) return { devices: parsed };
    const detail = (stderr.trim().split(/\r?\n/).pop() || e?.message || String(e)).trim();
    return {
      devices: [],
      error: e?.killed
        ? `llama-server --list-devices did not answer within ${LIST_DEVICES_TIMEOUT_MS / 1000}s`
        : `llama-server --list-devices failed: ${detail}`,
    };
  }
  const parsed = parseDeviceList(stdout);
  if (parsed) return { devices: parsed };
  const detail = (stderr.trim().split(/\r?\n/).pop() || stdout.trim().split(/\r?\n/).pop() || '').trim();
  return {
    devices: [],
    error: `llama-server --list-devices printed no device list${detail ? `: ${detail}` : ''}`,
  };
}

/** Streaming SHA-256 — engine archives are tens of MB; never buffer whole. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
