// Voice prompting, first half: getting the speech engine onto this computer.
//
// Two downloads land in `<userData>/voice/` — the sherpa-onnx native runtime
// (an npm tarball, ~8-14 MB, plus its 12 KB JavaScript wrappers) and the
// Parakeet speech model (a 487 MB .tar.bz2). Both are pinned in voice-pin.ts.
//
// The SHAPE is engine/engine-acquisition.ts's, deliberately: download → verify
// → unpack into a `.unpacking` SIBLING → write the `.complete` marker INSIDE it
// LAST → rename into place. The invariant that shape exists for: NEVER leave a
// half-unpacked directory marked usable. A crash, a power cut or a killed app
// mid-unpack leaves either no directory at all or a complete one — never a
// folder that looks installed and cannot load.
//
// THREE things are done differently here, each on purpose, not by drift:
//
//  1. `net.fetch` (Electron's), not the global `fetch`. Electron's honours the
//     system proxy; Node's does not, and reports a corporate proxy and an
//     unplugged network cable identically as "fetch failed" — which would put a
//     guessed cause in front of the user. net.fetch rejects with the real reason
//     in `err.message` and sets NO `cause`, so that is what gets surfaced;
//     `err.cause` is kept only as a fallback for any caller still on Node's.
//
//  2. The verifier takes {algo, encoding, digest} rather than a bare hex SHA-256,
//     because npm publishes SHA-512 in base64 and the model release publishes
//     SHA-256 in hex. See voice-pin.ts's header.
//
//  3. The bzip2 decompressor is NAMED, and its absence is CHECKED. This is the
//     app's first .tar.bz2. Verified on this Linux machine 2026-09-05 with GNU
//     tar 1.35: `tar -xf sample.tar.bz2` does NOT decompress bzip2 itself — it
//     shells out, preferring `lbzip2` and falling back to `bzip2`, and with
//     neither on PATH it fails with "tar (child): lbzip2: Cannot exec: No such
//     file or directory". That message names a program the user never installed
//     and never heard of, for a step they did not know existed. So on Linux the
//     decompressor is chosen explicitly and piped into tar, and a machine with
//     none gets a sentence that says what is missing and what to do.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as electron from 'electron';
import type { DigestPin, VoiceArchive } from './voice-pin';
import {
  SHERPA_VERSION, VOICE_MODEL, VOICE_WRAPPERS, MODEL_DIR_NAME,
  pickRuntime, unsupportedReason, totalDownloadBytes,
  voiceRoot, runtimeDir, addonPath, wrapperEntryPath, modelDir,
} from './voice-pin';

const execFileAsync = promisify(execFile);
// Progress events throttled so a 487 MB download doesn't flood IPC.
const PROGRESS_INTERVAL_MS = 250;

/** How the download reports itself. The phases are the design's, in order:
 *  `downloading` (a real percentage over BOTH halves combined, so the bar never
 *  restarts) → `unpacking` (bzip2 on half a gigabyte takes tens of seconds, and
 *  has no percentage to report) → `ready`. voice-service.ts turns these into the
 *  `readiness` events the card renders. */
export type VoiceAssetProgress =
  | { phase: 'downloading'; receivedBytes: number; totalBytes: number; percent: number }
  | { phase: 'unpacking' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };

/** Everything a caller needs to actually use what was installed. voice-worker.ts
 *  takes these paths as given and builds none of them itself. */
export interface InstalledVoiceAssets {
  voiceRoot: string;
  addonPath: string;
  wrapperEntryPath: string;
  modelDir: string;
}

/** Electron's `net.fetch` is NOT assignable to `typeof fetch`, so this module
 *  declares the slice it actually uses instead of borrowing that alias. */
export type VoiceFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

/** WHY the electron import is a namespace and the call is lazy: the test stub
 *  for `electron` has no `net`, and a named import of a missing export fails at
 *  module load — before a single test runs. Nothing here touches `net` unless a
 *  real download starts. */
const defaultFetch: VoiceFetch = (url, init) => electron.net.fetch(url, init);

interface CompleteMarker {
  sherpaVersion: string;
  /** What must still exist for this directory to count as usable. */
  requiredRelPaths: string[];
  /** The digest of the archive this directory was unpacked from, when it has one.
   *  WHY: the runtime is identified by its version, but the MODEL is not — if the
   *  pinned model archive is ever re-uploaded or re-pinned under the same name, a
   *  version check alone would keep serving the old one forever and nothing would
   *  re-download. Recording the digest makes the marker say WHICH model this is. */
  archiveDigest?: string;
}

export class VoiceAssets {
  private fetchImpl: VoiceFetch;

  /** `userDataPath` is Electron's userData directory; every path below is
   *  derived from it through voice-pin.ts so there is exactly one layout. */
  constructor(private userDataPath: string, fetchImpl?: VoiceFetch) {
    this.fetchImpl = fetchImpl ?? defaultFetch;
  }

  /** The paths, whether or not anything is installed there yet. */
  paths(): InstalledVoiceAssets {
    return {
      voiceRoot: voiceRoot(this.userDataPath),
      addonPath: addonPath(this.userDataPath),
      wrapperEntryPath: wrapperEntryPath(this.userDataPath),
      modelDir: modelDir(this.userDataPath),
    };
  }

  /** Non-null only when BOTH halves are fully installed: each directory carries
   *  a `.complete` marker AND every file that marker promised is still on disk.
   *
   *  The marker alone is not enough, and that is the whole point — the same
   *  existence check engine-acquisition uses. A half-unpacked directory has no
   *  marker (it is written last, inside the scratch directory), and a directory
   *  someone half-deleted has a marker with files missing. Both answer null. */
  installed(): InstalledVoiceAssets | null {
    const p = this.paths();
    if (!this.isComplete(runtimeDir(this.userDataPath))) return null;
    if (!this.isComplete(this.modelRoot(), VOICE_MODEL.digest.digest)) return null;
    return p;
  }

  private modelRoot(): string {
    return path.join(voiceRoot(this.userDataPath), 'model');
  }

  private isComplete(dir: string, expectDigest?: string): boolean {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')) as CompleteMarker;
      if (marker.sherpaVersion !== SHERPA_VERSION) return false;
      // A directory unpacked from a DIFFERENT archive than the one pinned today is
      // not the thing we promised; re-download rather than serve the old model.
      if (expectDigest && marker.archiveDigest !== expectDigest) return false;
      return marker.requiredRelPaths.every((rel) => fs.existsSync(path.join(dir, rel)));
    } catch {
      return false; // no marker, unreadable marker, or half-deleted → not usable
    }
  }

  /** In flight, if an install is running. WHY this exists: each unpack starts by
   *  DELETING its scratch directory and every exit deletes both scratch dirs, so two
   *  concurrent installs on one profile delete each other's work mid-unpack and BOTH
   *  fail — measured 2026-09-05, with the user shown a sentence naming `tar` and a
   *  temp path. The never-half-unpacked invariant held, but nobody got a download.
   *  A second caller now waits for the first instead of racing it. */
  private inFlight: Promise<InstalledVoiceAssets> | null = null;

  /** Download, verify and unpack both halves. Idempotent: an already-usable install
   *  returns immediately, and a second call while one is running joins it rather than
   *  starting a competing one — so pressing Download twice really is harmless. */
  async install(onProgress: (p: VoiceAssetProgress) => void): Promise<InstalledVoiceAssets> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runInstall(onProgress).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runInstall(onProgress: (p: VoiceAssetProgress) => void): Promise<InstalledVoiceAssets> {
    const already = this.installed();
    if (already) {
      onProgress({ phase: 'ready' });
      return already;
    }

    const runtime = pickRuntime(process.platform, process.arch);
    if (!runtime) {
      // Windows-on-ARM: the runtime is not published, so there is nothing to
      // download. Say that, rather than failing a fetch nobody could have won.
      const message = unsupportedReason(process.platform, process.arch)
        ?? `Voice typing is not available on this computer (${process.platform} ${process.arch}).`;
      onProgress({ phase: 'error', message });
      throw new Error(message);
    }

    const root = voiceRoot(this.userDataPath);
    const runtimeFinal = runtimeDir(this.userDataPath);
    const modelFinal = this.modelRoot();
    fs.mkdirSync(root, { recursive: true });

    const totalBytes = totalDownloadBytes(runtime);
    let carried = 0; // bytes finished in EARLIER archives — keeps the bar monotonic
    const report = (receivedInThisArchive: number) => {
      const receivedBytes = carried + receivedInThisArchive;
      onProgress({
        phase: 'downloading',
        receivedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0,
      });
    };

    const runtimeArchive = path.join(root, `${runtime.npmPackage}-${SHERPA_VERSION}.tgz.download`);
    const wrapperArchive = path.join(root, `${VOICE_WRAPPERS.npmPackage}-${SHERPA_VERSION}.tgz.download`);
    const modelArchive = path.join(root, `${MODEL_DIR_NAME}.tar.bz2.download`);

    try {
      await this.getVerified(runtime, runtimeArchive, report);
      carried += runtime.bytes;
      await this.getVerified(VOICE_WRAPPERS, wrapperArchive, report);
      carried += VOICE_WRAPPERS.bytes;
      await this.getVerified(VOICE_MODEL, modelArchive, report);
      carried += VOICE_MODEL.bytes;
      report(0);

      onProgress({ phase: 'unpacking' });

      // --- the runtime: native addon first, JS wrappers unpacked ON TOP ---
      // Both npm tarballs are rooted at `package/`, so they land in the same
      // directory by construction — which is exactly what makes the wrappers'
      // relative `require('./sherpa-onnx.node')` resolve with no node_modules
      // anywhere. Order matters: the wrapper package's package.json (main:
      // sherpa-onnx.js) deliberately overwrites the platform package's.
      const runtimePartial = `${runtimeFinal}.unpacking`;
      fs.rmSync(runtimePartial, { recursive: true, force: true });
      fs.mkdirSync(runtimePartial, { recursive: true });
      await unpackTarGz(runtimeArchive, runtimePartial);
      await unpackTarGz(wrapperArchive, runtimePartial);
      requireLayout(runtimePartial, runtime.requiredRelPaths, 'speech runtime');
      requireLayout(runtimePartial, VOICE_WRAPPERS.requiredRelPaths, 'speech runtime');
      writeMarkerAndRename(runtimePartial, runtimeFinal, [
        ...runtime.requiredRelPaths, ...VOICE_WRAPPERS.requiredRelPaths,
      ]);

      // --- the model ---
      const modelPartial = `${modelFinal}.unpacking`;
      fs.rmSync(modelPartial, { recursive: true, force: true });
      fs.mkdirSync(modelPartial, { recursive: true });
      await unpackTarBz2(modelArchive, modelPartial);
      requireLayout(modelPartial, VOICE_MODEL.requiredRelPaths, 'speech model');
      writeMarkerAndRename(modelPartial, modelFinal, VOICE_MODEL.requiredRelPaths, VOICE_MODEL.digest.digest);

      fs.rmSync(runtimeArchive, { force: true });
      fs.rmSync(wrapperArchive, { force: true });
      fs.rmSync(modelArchive, { force: true });

      onProgress({ phase: 'ready' });
      return this.paths();
    } catch (e: unknown) {
      // The real reason, never a guess — the card prints this verbatim next to
      // a Retry button (docs/error-message-standards.md).
      const message = e instanceof Error ? e.message : String(e);
      onProgress({ phase: 'error', message });
      throw e;
    } finally {
      // Scratch directories never survive a failure; the partial .download
      // files DO, on purpose, so a retry resumes instead of restarting 487 MB.
      fs.rmSync(`${runtimeFinal}.unpacking`, { recursive: true, force: true });
      fs.rmSync(`${modelFinal}.unpacking`, { recursive: true, force: true });
    }
  }

  /** Download one archive (resuming a partial file if one is there) and check it
   *  against its pin before anyone unpacks it. */
  private async getVerified(
    archive: VoiceArchive, dest: string, report: (received: number) => void,
  ): Promise<void> {
    await this.download(archive, dest, report);
    const actual = await fileDigest(dest, archive.digest);
    if (actual !== archive.digest.digest) {
      // Delete it: a corrupt file left on disk would be "resumed" forever.
      fs.rmSync(dest, { force: true });
      throw new Error(
        `${capitalise(archive.label)} did not download correctly — its ${describeDigest(archive.digest)} `
        + `should be ${archive.digest.digest} but the downloaded file is ${actual}. `
        + `The file was discarded; try the download again.`,
      );
    }
  }

  /** Streaming download with Range-based resume. Both hosts (npm's registry and
   *  GitHub's release CDN) redirect and support Range requests. */
  private async download(
    archive: VoiceArchive, dest: string, report: (received: number) => void,
  ): Promise<void> {
    let start = 0;
    try { start = fs.statSync(dest).size; } catch { /* no partial file yet */ }

    // A part-file that is ALREADY the whole file: digest it and skip the network
    // entirely. Without this, a crash or a quit between the last byte and the digest
    // check costs a second 487 MB download — the Range request 416s, the file is
    // deleted, and it starts from zero. Measured 2026-09-05: 290 of 290 bytes were
    // re-served for a byte-perfect part-file.
    if (start >= archive.bytes) {
      const good = await digestMatches(dest, archive.digest);
      if (good) { report(archive.bytes); return; }
      fs.rmSync(dest, { force: true });
      start = 0;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(archive.url, {
        headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
      });
    } catch (e: unknown) {
      // net.fetch puts the real reason in err.message and sets no cause; err.cause
      // is read only as a fallback for a caller still on Node's fetch.
      throw new Error(`Could not download ${archive.label}: ${networkReason(e)}`);
    }
    if (res.status === 416) {
      // The partial file is already the whole file (or longer). Start clean.
      fs.rmSync(dest, { force: true });
      return this.download(archive, dest, report);
    }
    if (!res.ok && res.status !== 206) {
      throw new Error(`Could not download ${archive.label}: the server responded with HTTP ${res.status}.`);
    }
    if (start > 0 && res.status !== 206) {
      // Server ignored the Range header and is sending the whole file again.
      fs.rmSync(dest, { force: true });
      start = 0;
    }
    if (!res.body) throw new Error(`Could not download ${archive.label}: the server sent an empty response.`);

    const ws = fs.createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' });
    // A write-stream 'error' raised OUTSIDE a pending write callback (disk full,
    // EACCES, a flush during end()) is otherwise unhandled — and an unhandled
    // stream error crashes the Electron main process. Half a gigabyte makes
    // disk-full a real path, not a theoretical one.
    let streamError: Error | null = null;
    ws.on('error', (err: Error) => { streamError = err; });
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
          report(received);
        }
      }
      report(received);
    } finally {
      await reader.cancel().catch(() => {}); // release the body on every exit path
      await new Promise<void>((resolve) => ws.end(() => resolve()));
    }
    if (streamError) throw streamError; // a flush error surfacing only at end()
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Streaming digest — these archives are up to 487 MB; never buffer whole. */
function fileDigest(file: string, pin: DigestPin): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(pin.algo);
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest(pin.encoding)));
  });
}

/** True when the file on disk already matches the pin. Used to reuse a part-file
 *  that is already complete instead of re-downloading half a gigabyte. */
async function digestMatches(file: string, pin: DigestPin): Promise<boolean> {
  try { return (await fileDigest(file, pin)) === pin.digest; } catch { return false; }
}

/** "SHA-512 fingerprint (base64)" — so the mismatch message says which of the
 *  two shapes it is talking about, and a reader can re-run the right command. */
function describeDigest(pin: DigestPin): string {
  const algo = pin.algo === 'sha256' ? 'SHA-256' : 'SHA-512';
  return `${algo} fingerprint (${pin.encoding})`;
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The reason a fetch rejected, as the network layer reported it. */
function networkReason(e: unknown): string {
  if (e instanceof Error) {
    // Electron's net.fetch: the reason is here and there is no cause.
    if (e.message) return e.message;
    // Node's fetch: the message is the useless "fetch failed"; the cause has it.
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

// On Windows, `tar` MUST be the System32 bsdtar (libarchive): a bare `tar` on
// PATH can resolve to Git's GNU tar, which mis-reads the colon in `C:\...` as an
// rsh host:path. Same reasoning, and the same line, as engine-acquisition.ts's
// systemTar() — kept local rather than exported across subsystems.
function systemTar(): string {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

/** npm tarballs. Every tar in play reads gzip without help. */
async function unpackTarGz(archive: string, destDir: string): Promise<void> {
  await execFileAsync(systemTar(), ['-xf', archive, '-C', destDir]);
}

/** The bzip2 programs tar itself looks for, in tar's own order of preference
 *  (measured, see the module header). Whichever exists is fine: all three read
 *  the same format, the parallel ones are simply faster. */
const BZIP2_PROGRAMS = ['lbzip2', 'pbzip2', 'bzip2'];

/** The model archive. See departure 3 in the module header for WHY this does
 *  not just call `tar -xf`. */
async function unpackTarBz2(archive: string, destDir: string): Promise<void> {
  if (process.platform !== 'linux') {
    // Windows' System32 tar and macOS' /usr/bin/tar are both bsdtar, which links
    // libarchive and decompresses bzip2 IN-PROCESS — there is no helper program
    // that can be missing. NOT VERIFIED on this Linux development machine
    // (2026-09-05); the Linux path below is the one that was measured. If a Mac
    // or Windows unpack ever fails here, the fix is to extend the named-program
    // path below to those platforms, not to add a guess to this comment.
    await execFileAsync(systemTar(), ['-xf', archive, '-C', destDir]);
    return;
  }

  const program = await findBzip2();
  await pipeThroughTar(program, archive, destDir);
}

/** Which bzip2 program this machine has, or a sentence saying it has none.
 *  "Checked", not "assumed" — and the message names what is missing, instead of
 *  tar's "lbzip2: Cannot exec", which names a program nobody chose to install.
 *
 *  WHY spawn with stdio 'ignore' rather than execFile: `bzip2 -V` prints its
 *  version and then goes on to compress STANDARD INPUT. execFile gives the child
 *  an open stdin pipe that nothing ever closes, so the probe never returns — it
 *  hung the whole test suite for 30 s a test before this was found (2026-09-05).
 *  'ignore' hands it /dev/null, which is an immediate end-of-input. */
function probeProgram(program: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = spawn(program, ['-V'], { stdio: 'ignore' });
    // ONLY "no such file" means the program is absent. EACCES, EMFILE or ENOMEM on a
    // machine that HAS bzip2 would otherwise be reported as "this computer has no
    // bzip2 program", which is a hardcoded guess replacing a real error — the exact
    // shape docs/error-message-standards.md forbids.
    probe.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') { resolve(false); return; }
      reject(new Error(`Could not check for ${program}: ${err.message}`));
    });
    probe.on('close', () => resolve(true));  // it ran, whatever it thought of -V
  });
}

async function findBzip2(): Promise<string> {
  for (const program of BZIP2_PROGRAMS) {
    if (await probeProgram(program)) return program;
  }
  throw new Error(
    'The speech model could not be unpacked: this computer has no bzip2 program '
    + `(looked for ${BZIP2_PROGRAMS.join(', ')}). Install bzip2 and try the download again.`,
  );
}

/** `<program> -dc archive | tar -x -C destDir`, with both programs' own error
 *  output preserved — a failure here reports what the tools said, not a guess. */
function pipeThroughTar(program: string, archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const decompress = spawn(program, ['-dc', archive], { stdio: ['ignore', 'pipe', 'pipe'] });
    const untar = spawn(systemTar(), ['-x', '-C', destDir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      decompress.kill();
      untar.kill();
      reject(new Error(message));
    };

    decompress.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    untar.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    decompress.on('error', (err: Error) => fail(`The speech model could not be unpacked: ${program} could not run (${err.message}).`));
    untar.on('error', (err: Error) => fail(`The speech model could not be unpacked: tar could not run (${err.message}).`));
    decompress.stdout.pipe(untar.stdin);
    // EPIPE when tar dies first is not a separate failure — tar's own exit
    // already reports it, and an unhandled 'error' here would crash main.
    untar.stdin.on('error', () => {});

    decompress.on('close', (code) => {
      if (code !== 0 && code !== null) fail(`The speech model could not be unpacked: ${program} exited with code ${code}. ${stderr.trim()}`.trim());
    });
    untar.on('close', (code) => {
      if (settled) return;
      if (code === 0) { settled = true; resolve(); return; }
      fail(`The speech model could not be unpacked: tar exited with code ${code}. ${stderr.trim()}`.trim());
    });
  });
}

/** The stale-layout tripwire, in engine-acquisition's words: if the archive did
 *  not contain what voice-pin.ts promised, fail loudly HERE rather than install
 *  a directory that looks complete and cannot load. */
function requireLayout(dir: string, requiredRelPaths: string[], what: string): void {
  for (const rel of requiredRelPaths) {
    if (!fs.existsSync(path.join(dir, rel))) {
      throw new Error(
        `The ${what} archive did not contain ${rel} — the pinned layout in voice-pin.ts is stale.`,
      );
    }
  }
}

/** Marker LAST, then an atomic rename into place. The only two orders a crash
 *  can interrupt both leave either no final directory or a fully usable one. */
function writeMarkerAndRename(
  partialDir: string, finalDir: string, requiredRelPaths: string[], archiveDigest?: string,
): void {
  const marker: CompleteMarker = { sherpaVersion: SHERPA_VERSION, requiredRelPaths, archiveDigest };
  fs.writeFileSync(path.join(partialDir, '.complete'), JSON.stringify(marker));
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(partialDir, finalDir);
}
