// "Add vision" (design §E4) — a model already on disk whose repo publishes a
// vision projector: move it into a folder of its own and fetch the projector in
// beside it. llama-server only pairs a model with an `mmproj*.gguf` when the two
// sit together in ONE subdirectory of --models-dir, and it then names that model
// by the FOLDER (both probed on b10665, docs/engine-dependencies.md).
//
// THIS WHOLE FILE IS ABOUT ORDER, and the reason is a measured engine behaviour:
// `<cacheDir>/X.gguf` and `<cacheDir>/X/` are ONE model id to the router. It
// serves exactly one of the two and silently drops the other, and WHICH ONE IS
// NOT PREDICTABLE — the outcome follows directory-entry order, which belongs to
// the filesystem and not to us (measured on b10665, 2026-09-05: the same pair
// created in opposite orders was served from opposite sides on one server). So
// a half-populated folder does NOT reliably lose to the working flat file next
// to it: it can SHADOW it, and the user's model then stops loading with nothing
// on screen to explain why.
//
// The rule this file is built to keep: at no instant may a loadable flat file
// and a loadable folder of the same name both exist. `moveIntoOwnFolder` below
// carries the step-by-step argument for why its order leaves no such instant,
// forwards, and in rollback. The user's existing model survives every failure
// here.
import * as fs from 'fs';
import * as path from 'path';
import type { EngineModelState } from '../../shared/engine-types';
import type { QuantOption } from '../../shared/model-manager-types';
import { scanLocalDownloads, isComplete } from '../engine/cache-scan';
import { readManifest, manifestPathFor } from './download-manifest';

/** What this operation needs from the running engine. An interface rather than
 *  the EngineManager itself so the ordering — the part that can lose a user's
 *  model — is unit-testable without a router. */
export interface AddVisionEngine {
  /** Is a llama-server process running right now? When it is not, nothing can
   *  hold the model's file open and there is no router to ask about residency,
   *  so the unload + poll below are skipped rather than run against nothing. */
  running(): boolean;
  /** Requests naming this model in flight right now (EngineSupervisor's
   *  per-model count — NOT the engine-wide one, and not the session ref-count:
   *  a model with an open chat tab never releases its ref, so a wait on that
   *  would never end). */
  inFlightFor(modelId: string): number;
  /** `POST /models/unload` for one model. Best-effort by contract. */
  unload(modelId: string): Promise<void>;
  /** The ROUTER's own word on whether this model is resident. `null` means "could
   *  not be determined" and must never be read as "unloaded" — that confusion is
   *  what would let us rename a file the engine still has open. */
  modelState(modelId: string): Promise<EngineModelState | null>;
  /** `GET /models?reload=1` — tell the router the layout on disk changed. */
  refreshModels(): Promise<void>;
}

/** Timing seams. A guard that has to wait out the real ten minutes is a guard
 *  that gets deleted, so every bound here is injectable. */
export interface AddVisionTiming {
  /** How often the per-model in-flight wait re-asks, and how long it waits
   *  before going ahead regardless (design §C2's bound, shared with the
   *  settings apply). */
  idlePollMs?: number;
  idleMaxWaitMs?: number;
  /** How often the "is it unloaded yet?" poll asks, and its hard bound. */
  unloadPollMs?: number;
  unloadTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const IDLE_POLL_MS = 1_000;
const IDLE_MAX_WAIT_MS = 10 * 60_000;
const UNLOAD_POLL_MS = 250;
// Design §E4's bound. `POST /models/unload` answers BEFORE the model child has
// exited, and a rename while the file is still open fails outright on Windows
// and quietly moves an open file on Linux — so the poll, not the unload, is what
// makes the move safe.
const UNLOAD_TIMEOUT_MS = 15_000;

/** The exact text the design specifies for the unload that never finished. */
export const STILL_BUSY_MESSAGE = 'The model is still busy — try again in a moment.';

/** The move failed and everything that moved was put back. */
export function moveFailedMessage(modelId: string, osError: string): string {
  return `Could not move ${modelId} into its own folder: ${osError}. Nothing was changed.`;
}

/** The move failed AND putting it back failed. "Nothing was changed" would be a
 *  lie here, so this says where the files actually are — the user can carry out
 *  the undo by hand, and nothing is lost either way. */
export function rollbackFailedMessage(
  modelId: string, osError: string, rollbackError: string, folder: string, cacheDir: string
): string {
  return `Could not move ${modelId} into its own folder: ${osError}. Putting its files back failed too: `
    + `${rollbackError}. Some of them are now in ${folder} — move them back into ${cacheDir} `
    + 'to use the model again.';
}

/** Fetch the vision projector for an installed model, moving the model into a
 *  folder of its own first when it is still flat. Returns the download id of the
 *  projector fetch, which rides the normal download progress stream.
 *
 *  `startDownload` is ModelManager.download — the ordinary path, so the disk
 *  guard, the in-flight reservation and the progress events are the same ones
 *  every other download gets. It is passed in rather than imported so this
 *  module owns only the ordering. */
export async function addVisionToModel(
  cacheDir: string,
  modelId: string,
  engine: AddVisionEngine,
  startDownload: (repo: string, quant: QuantOption) => Promise<{ downloadId: string }>,
  timing: AddVisionTiming = {},
): Promise<{ downloadId: string }> {
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const now = timing.now ?? Date.now;

  // ---- What is actually on disk, and is this operation even the right one? ----
  const row = scanLocalDownloads(cacheDir).find((d) => d.modelId === modelId);
  if (!row) {
    throw new Error(`${modelId} is not in your models folder, so there is nothing to add a vision file to.`);
  }
  if (!isComplete(row)) {
    throw new Error(`${modelId} has not finished downloading, so its vision file cannot be added yet.`);
  }
  if (row.hasProjector) {
    throw new Error(`${modelId} already has its vision file.`);
  }
  const currentDir = row.subdir === null ? cacheDir : path.join(cacheDir, row.subdir);
  const manifest = row.hasManifest ? readManifest(currentDir, row.firstFileName) : null;
  // Same shape as ModelManager.resume's refusal, and for the same reason: a
  // record that never learned its repo (§E3 writes `repo: null` for a model it
  // could not identify) cannot be pointed at a file to download.
  if (!manifest || manifest.repo === null) {
    throw new Error(
      `There is no record of where ${modelId} came from, so its vision file cannot be downloaded. `
      + 'Delete it in Local Models and download it again.'
    );
  }
  const visionFile = manifest.visionFile;
  if (!visionFile) {
    throw new Error(`${modelId}'s download record does not name a vision file, so there is nothing to add.`);
  }
  // The projector has to land in the folder the ENGINE will read this model
  // from, which is the folder named by the model id. downloadDirFor derives that
  // name from the manifest's first file, so the two must agree — if they do not,
  // the projector would be fetched into a folder nothing loads, and the model
  // would look unchanged forever.
  const manifestId = path.basename(manifest.files[0] ?? '').replace(/\.gguf$/i, '');
  if (manifestId !== modelId) {
    throw new Error(
      `${modelId}'s download record describes a different file (${manifestId || 'none'}), `
      + 'so its vision file cannot be placed where the engine would read it. '
      + 'Delete it in Local Models and download it again.'
    );
  }

  // ---- 1. Wait until nothing is using this model ----
  // Bounded exactly as the settings apply is (§C2): at the next idle moment, or
  // after ten minutes regardless. Going ahead at the bound is safe because the
  // unload + poll below is what actually protects the file — a model that is
  // still busy then fails the poll and nothing is moved.
  const idleDeadline = now() + (timing.idleMaxWaitMs ?? IDLE_MAX_WAIT_MS);
  while (engine.inFlightFor(modelId) > 0 && now() < idleDeadline) {
    await sleep(timing.idlePollMs ?? IDLE_POLL_MS);
  }

  // ---- 2 & 3. Unload, then WAIT for the child to actually be gone ----
  // Only when an engine is running. With no process there is nothing holding the
  // file open and no router to answer the poll — and modelState would answer
  // `null` ("don't know") every time, which would spend the whole 15 s and then
  // refuse a move that was always safe.
  if (engine.running()) {
    await engine.unload(modelId);
    const unloadDeadline = now() + (timing.unloadTimeoutMs ?? UNLOAD_TIMEOUT_MS);
    for (;;) {
      const state = await engine.modelState(modelId);
      // ONLY 'unloaded' ends the wait. 'sleeping' frees the model's memory but
      // the child is still there holding its file, and `null` is "the router did
      // not answer" — reading either as done is how a rename lands on an open
      // file.
      if (state === 'unloaded') break;
      if (now() >= unloadDeadline) throw new Error(STILL_BUSY_MESSAGE);
      await sleep(timing.unloadPollMs ?? UNLOAD_POLL_MS);
    }
  }

  // ---- 4 & 5. Into a folder of its own ----
  // Skipped when this model is ALREADY in a folder: that is §E2's crash-recovery
  // state — a fresh vision download whose weights landed and whose projector leg
  // did not — and it needs only the download below.
  const movedIntoFolder = row.subdir === null;
  if (movedIntoFolder) {
    moveIntoOwnFolder(cacheDir, modelId, row.firstFileName, row.partsDeclared);
    // The router is still advertising a path that no longer exists, so tell it
    // now rather than after the projector arrives: a send in between would fail
    // with the router's own "model not found". The SECOND reload — the one that
    // makes the engine pair the projector — is already wired to the download's
    // 'done' progress event in ipc-handlers.ts, so it is not repeated here.
    await engine.refreshModels();
  }

  // ---- 6. The projector, through the ordinary downloader ----
  // Rebuilt from the manifest exactly as resume() does, with the vision file
  // carried through: that is what puts downloadDirFor on the model's folder and
  // what makes the fetch one more leg of the same job the weights arrived by.
  // The weights are already published, so the downloader skips them (crediting
  // their bytes) and the disk guard is charged for the projector alone.
  return startDownload(manifest.repo, {
    quant: manifest.quant,
    description: '',
    files: manifest.files,
    totalSizeBytes: manifest.totalSizeBytes,
    sha256ByFile: manifest.sha256ByFile,
    visionFile,
    visionBytes: visionFile.size,
  });
}

/** The two filesystem mutations the move makes, as an injectable seam.
 *
 *  WHY a seam rather than a spy: `import * as fs` gives an ESM namespace whose
 *  properties cannot be redefined, so `vi.spyOn(fs, 'renameSync')` does not
 *  reach this module (measured 2026-09-05 — the spy records nothing and the real
 *  rename still runs). The same problem is why ModelManager has a
 *  `freeDiskBytes` seam. Without this, the rollback — the part that decides
 *  whether a user keeps their model when a rename fails — could not be driven at
 *  all, and an unprovable rollback is worse than none. */
export interface MoveOps {
  mkdir(dir: string): void;
  rename(from: string, to: string): void;
  /** Only ever called on a folder expected to be EMPTY: rmdir refuses a
   *  non-empty one, which is the check we want rather than a recursive force. */
  rmdir(dir: string): void;
}

export const REAL_MOVE_OPS: MoveOps = {
  mkdir: (dir) => { fs.mkdirSync(dir); },
  rename: (from, to) => { fs.renameSync(from, to); },
  rmdir: (dir) => { fs.rmdirSync(dir); },
};

/** Every file of one split set, part 1 first, whether or not it is on disk. */
function setFileNames(firstFileName: string, partsDeclared: number): string[] {
  if (partsDeclared <= 1) return [firstFileName];
  const total = String(partsDeclared).padStart(5, '0');
  const stem = firstFileName.replace(/-\d{5}-of-\d{5}\.gguf$/i, '');
  return Array.from({ length: partsDeclared }, (_, i) =>
    `${stem}-${String(i + 1).padStart(5, '0')}-of-${total}.gguf`);
}

/** Move a flat model into `<cacheDir>/<modelId>/`, or put back what moved.
 *
 *  WHY THIS ORDER — and why it leaves no window at all, rather than merely a
 *  small one. The pair `<cacheDir>/X.gguf` + `<cacheDir>/X/` is unsafe only when
 *  BOTH sides are loadable; a folder holding no `*.gguf` is not a model to the
 *  router or to cache-scan, so it is not a side of anything.
 *
 *    1. `mkdir <cacheDir>/<id>/`, NOT recursive — an empty folder is not a
 *       model, and a folder that already exists is a real, reportable state
 *       rather than something to silently merge into.
 *    2. The manifest, then any `.partial`. Neither is a `*.gguf`; the folder
 *       still holds no model, and the flat file is still the one and only
 *       loadable copy.
 *    3. `<id>.gguf` → `<id>/<id>.gguf`. ONE rename, and rename is atomic: the
 *       instant the folder becomes loadable is the same instant the flat file
 *       stops existing. This single step is what flips which layout holds the
 *       model, and it cannot be observed half-done — not by the router, not by
 *       cache-scan, not by a crash.
 *    4. Parts 2..N. A follower part (`…-00002-of-00003.gguf`) is never a model
 *       id anything addresses — the router rows it flat under its own name and
 *       the app drops follower rows — so moving them cannot create a second
 *       thing called `<id>`. In between, the folder holds an incomplete set;
 *       that is a model that would fail to load, not a model that shadows a
 *       working one, and no `?reload=1` is sent until the move has finished.
 *
 *  Rollback replays the same list in reverse, for the same reason: undoing step
 *  3 is again one atomic rename, out of a folder left holding only non-loadable
 *  files. So a failure at any step ends with the model exactly as it was.
 *
 *  Everything before this point exists so that this runs against files nothing
 *  has open: `POST /models/unload` returns before the model child exits, and
 *  renaming an open file fails on Windows and succeeds-but-moves-it on Linux. */
export function moveIntoOwnFolder(
  cacheDir: string, modelId: string, firstFileName: string, partsDeclared: number,
  ops: MoveOps = REAL_MOVE_OPS
): void {
  const folder = path.join(cacheDir, modelId);
  const parts = setFileNames(firstFileName, partsDeclared);
  const exists = (name: string) => fs.existsSync(path.join(cacheDir, name));
  // Step 2's files: the manifest and any leftover .partial — nothing here is a
  // *.gguf, so none of it can make the folder loadable.
  const companions = [
    path.basename(manifestPathFor(cacheDir, firstFileName)),
    ...parts.map((name) => `${name}.partial`),
  ].filter(exists);
  const followers = parts.slice(1).filter(exists);
  const order = [...companions, firstFileName, ...followers];

  try {
    ops.mkdir(folder);
  } catch (e: any) {
    throw new Error(moveFailedMessage(modelId, osErrorText(e)));
  }
  const moved: string[] = [];
  try {
    for (const name of order) {
      ops.rename(path.join(cacheDir, name), path.join(folder, name));
      moved.push(name);
    }
  } catch (e: any) {
    const failure = osErrorText(e);
    try {
      for (const name of [...moved].reverse()) {
        ops.rename(path.join(folder, name), path.join(cacheDir, name));
      }
      ops.rmdir(folder);
    } catch (undoErr: any) {
      throw new Error(rollbackFailedMessage(modelId, failure, osErrorText(undoErr), folder, cacheDir));
    }
    throw new Error(moveFailedMessage(modelId, failure));
  }
}

/** The OS's own words, never a guess at what they mean. The trailing full stop
 *  is dropped because the message template adds one. */
function osErrorText(e: any): string {
  const raw = (e?.message ?? String(e)).trim();
  return raw.replace(/\.$/, '') || 'the operating system gave no reason';
}
