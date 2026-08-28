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

export interface InstalledEngine {
  version: string;
  backend: EngineBackend;
  binaryPath: string;   // absolute path to llama-server(.exe)
  dir: string;
}

interface CompleteMarker { version: string; backend: EngineBackend; binaryRelPath: string; }

export class EngineAcquisition {
  /** engineRoot = <userData>/engine — per-machine, never synced (Phase 0 §1). */
  constructor(private engineRoot: string, private fetchImpl: typeof fetch = fetch) {}

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
          found.push({ version: marker.version, backend: marker.backend, binaryPath, dir });
        }
      } catch { /* no marker / unreadable → not a usable install; skip */ }
    }
    const pinned = found.filter((f) => f.version === ENGINE_VERSION);
    if (preferBackend) {
      const match = pinned.find((f) => f.backend === preferBackend);
      if (match) return match;
    }
    return pinned[0] ?? found[0] ?? null;
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
          onProgress({ kind: 'done', version: ENGINE_VERSION, backend: asset.backend });
          return { version: ENGINE_VERSION, backend: asset.backend, binaryPath: bin, dir: finalDir };
        }
      } catch { /* corrupt marker → reinstall below */ }
    }

    fs.mkdirSync(this.engineRoot, { recursive: true });
    const archivePath = path.join(this.engineRoot, `${asset.assetName}.download`);
    try {
      await this.download(assetUrl(asset), archivePath, onProgress);

      onProgress({ kind: 'verify' });
      const hash = await sha256File(archivePath);
      if (hash !== asset.sha256) {
        fs.rmSync(archivePath, { force: true });
        throw new Error('The downloaded engine failed its integrity check — please try installing again.');
      }

      onProgress({ kind: 'unpack' });
      const partialDir = `${finalDir}.unpacking`;
      fs.rmSync(partialDir, { recursive: true, force: true });
      fs.mkdirSync(partialDir, { recursive: true });
      // System bsdtar handles BOTH shapes: .zip (Windows builds) and .tar.gz —
      // no unzip dependency to bundle. See systemTar() for the Windows caveat.
      await execFileAsync(systemTar(), ['-xf', archivePath, '-C', partialDir]);

      const binaryPath = path.join(partialDir, asset.binaryRelPath);
      if (!fs.existsSync(binaryPath)) {
        throw new Error(
          `The engine archive did not contain ${asset.binaryRelPath} — the pinned layout in engine-pin.ts is stale.`
        );
      }
      if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755);

      // Marker LAST, then atomic rename into place — the only two orders that
      // can crash mid-way both leave either no finalDir or a fully-usable one.
      const marker: CompleteMarker = { version: ENGINE_VERSION, backend: asset.backend, binaryRelPath: asset.binaryRelPath };
      fs.writeFileSync(path.join(partialDir, '.complete'), JSON.stringify(marker));
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(partialDir, finalDir);
      fs.rmSync(archivePath, { force: true });

      onProgress({ kind: 'done', version: ENGINE_VERSION, backend: asset.backend });
      return {
        version: ENGINE_VERSION, backend: asset.backend,
        binaryPath: path.join(finalDir, asset.binaryRelPath), dir: finalDir,
      };
    } catch (e: any) {
      onProgress({ kind: 'error', message: e?.message ?? String(e) });
      throw e;
    } finally {
      fs.rmSync(`${finalDir}.unpacking`, { recursive: true, force: true });
    }
  }

  /** Streaming download with Range-based resume. GitHub release assets are
   *  redirect-served (Node fetch follows) and support Range requests. */
  private async download(url: string, dest: string, onProgress: (p: EngineInstallProgress) => void): Promise<void> {
    let start = 0;
    try { start = fs.statSync(dest).size; } catch { /* no partial */ }

    const res = await this.fetchImpl(url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
    });
    if (res.status === 416) {
      fs.rmSync(dest, { force: true });
      return this.download(url, dest, onProgress);
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
    const totalBytes = lenHeader ? Number(lenHeader) + start : null;
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
          onProgress({ kind: 'download', receivedBytes: received, totalBytes });
        }
      }
      onProgress({ kind: 'download', receivedBytes: received, totalBytes });
    } finally {
      await reader.cancel().catch(() => {}); // release the response body on any exit path
      await new Promise<void>((resolve) => ws.end(() => resolve()));
    }
    // A flush error surfacing only at end() must fail the install, not pass silently.
    if (streamError) throw streamError;
  }
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
