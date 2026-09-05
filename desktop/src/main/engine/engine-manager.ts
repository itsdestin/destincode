// EngineManager — the composition root ipc-handlers talks to. Owns one
// EngineAcquisition + (lazily) one EngineSupervisor, reads engine config from
// ~/.youcoded/config.json, and exposes:
//   - status()/install()/restart() for the engine:* IPC surface
//   - registryHook() — the LocalEngineHook ProviderRegistry's local-engine
//     branch calls (installed / ensureRunning / trackedFetch)
//   - catalogModels() — ModelCatalog's local source for the model picker
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs'; // Plan C: deleteModel needs fs.rmSync for model files
import { NativeHome } from '../native-home';
import { EngineAcquisition, InstalledEngine } from './engine-acquisition';
import { EngineSupervisor } from './engine-supervisor';
import { ENGINE_VERSION, pickAsset, defaultBackend } from './engine-pin';
import type { EngineAsset } from './engine-pin';
import { readEngineConfig, updateEngineConfig } from './engine-config';
import { readManifest, removeManifest, markManifestComplete, isManifestComplete } from '../models/download-manifest';
import { scanGgufCache, scanLocalDownloads, isComplete } from './cache-scan';
import { parseGgufName, quantDescription } from '../models/quant-parser';
import { stripSplitSuffix } from '../../shared/gguf-split';
import { detectGpu, backendOptions, gpuDeviceName } from '../models/gpu-detector';
import type { GpuVendor } from '../../shared/model-manager-types';
import { checkRocmPrereqs } from './rocm-prereqs';
import type {
  EngineBackend, EngineInstallProgress, EngineStatus, EngineModel, BackendOption,
} from '../../shared/engine-types';
import type { CatalogModel } from '../../shared/provider-types';
import type { InstalledLocalModel } from '../../shared/model-manager-types';

/** What ProviderRegistry's local-engine branch consumes (replaces Plan A's
 *  bare localBaseUrl callback). Defined here, imported by provider-registry. */
export interface LocalEngineHook {
  installed(): boolean;
  ensureRunning(): Promise<string>;   // OpenAI-compatible base URL (…/v1)
  fetchImpl(): typeof fetch;          // supervisor.trackedFetch — idle accounting sees every request
  /** Can the router actually SERVE this model right now? Fails OPEN. */
  ensureServable(modelId: string): Promise<boolean>;
}

/** Pick the asset to install: the preferred backend if it ships an asset for
 *  this platform/arch, else CPU (which every shipped platform has), else null.
 *  Returns the backend too so the caller records the one it actually used.
 *  Fix: Windows arm64 has no Vulkan asset — without this fallback Install would
 *  error out ("not available") even though a CPU build exists. */
export function selectInstallAsset(
  platform: string, arch: string, preferred: EngineBackend
): { asset: EngineAsset; backend: EngineBackend } | null {
  const first = pickAsset(platform, arch, preferred);
  if (first) return { asset: first, backend: preferred };
  const cpu = pickAsset(platform, arch, 'cpu');
  if (cpu) return { asset: cpu, backend: 'cpu' };
  return null;
}

// The REAL effective context window for a local model = min(what llama-server
// actually loaded, the GGUF-trained max). Guessing this overflows small models:
// a 4k-trained model driven at a configured 32k -c silently corrupts once history
// crosses the file's real ceiling. Take the smaller of the two known numbers;
// with neither known, fall back to a conservative default that nothing overruns.
/** Resolve the window from a RAW /props reading plus our own configured -c.
 *
 *  Extracted as a pure function because the bug this exists to prevent lived in
 *  an inline expression that no test could reach: `loaded ?? configured` does
 *  NOT fall back when loaded is 0, because `??` only catches null/undefined. In
 *  router mode /props reports a literal `n_ctx: 0`, so the fallback added on
 *  2026-07-26 was inert in precisely the case it was written for — and the unit
 *  tests passed anyway, because they exercised clampContextWindow directly with
 *  the values I ASSUMED reached it. Test the seam, not the collaborator.
 *
 *  A non-positive reading means "unknown", never "zero context". */
export function resolveEffectiveContext(
  loadedRaw: unknown,
  configured: number | null,
  trainedMax: number | null,
): number {
  const loaded = typeof loadedRaw === 'number' && Number.isFinite(loadedRaw) && loadedRaw > 0 ? loadedRaw : null;
  return clampContextWindow(loaded ?? configured, trainedMax);
}

export function clampContextWindow(loaded: number | null, trainedMax: number | null): number {
  const vals = [loaded, trainedMax].filter((n): n is number => typeof n === 'number' && n > 0);
  return vals.length ? Math.min(...vals) : 32_768;   // conservative default
}

// Task 13 fix pass — DiscoveredModel.totalSlots (capability-profile.ts) is fed
// by the SAME /props response effectiveContextWindow already reads for
// n_ctx, at the SAME "absent/zero/non-numeric means unknown" posture: router
// mode reports either a missing n_slots or (once a model IS loaded but the
// build predates this field) leaves it undefined, and a literal 0 must never
// be read as "zero slots" any more than n_ctx's literal 0 means "zero
// context" above. Extracted as its own pure function (mirroring
// resolveEffectiveContext just above, for the identical reason: the n_ctx
// router-mode bug shipped once already because the parsing lived inline
// where no test could reach it).
export function resolveSlotCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** What chip this computer has. These two facts CANNOT change while the app is
 *  running — the graphics card does not get swapped mid-session — which is why
 *  they, and only they, are the part that gets cached (§A3).
 *
 *  Split out from the two card fields deliberately. An earlier version cached
 *  the finished answer instead, and got both fields wrong on the path every new
 *  user walks: the Local Models panel is where the Install button lives, so the
 *  panel is opened BEFORE anything is installed. The answer was computed then,
 *  against no engine, and never recomputed — so after installing, the card said
 *  "Processor only" on a machine that was using its graphics chip, and kept
 *  offering a switch to the build it had just switched to. Everything that can
 *  change (which engine is installed, whether the ROCm libraries have since
 *  been installed, what the engine reports about its devices) is now read fresh
 *  on every status(). */
export interface MachineChip { vendor: GpuVendor | null; gfxTarget: string | null; }

async function probeMachineChip(): Promise<MachineChip> {
  const gpu = await detectGpu();
  // Warm the ROCm prerequisite reading on this same deferred tick, so that
  // status() — which is synchronous — can read it for free afterwards. It only
  // matters on an AMD machine, and it shells out, so nowhere else pays for it.
  if (gpu.vendor === 'amd') checkRocmPrereqs();
  return { vendor: gpu.vendor, gfxTarget: gpu.gfxTarget };
}

/** The device the engine says it will run on, from the install's `.complete`
 *  marker (engine-acquisition writes it from `llama-server --list-devices`).
 *
 *  Read on EVERY status() rather than cached: it changes when the engine is
 *  installed, and again when the backend is switched, and it is a small file
 *  read — no subprocess — so there is nothing to defer.
 *
 *  Three answers, not two. `undefined` means "not known yet": no engine
 *  installed, or a marker written before the device list existed (T2 backfills
 *  those lazily). `null` means the engine looked and found no graphics chip.
 *  A string is the chip. Collapsing the first two into `null` is what would let
 *  the card assert "Processor only" about a machine it has not asked yet. */
function deviceNameOf(inst: InstalledEngine | null): string | null | undefined {
  if (!inst) return undefined;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(inst.dir, '.complete'), 'utf8')) as { devices?: unknown };
    if (!Array.isArray(marker.devices)) return undefined;   // no device list recorded yet
    return gpuDeviceName(marker.devices);
  } catch {
    return undefined;   // no marker, or unreadable — not an answer, an absence
  }
}

export class EngineManager extends EventEmitter {
  private acquisition: EngineAcquisition;
  private supervisor: EngineSupervisor | null = null;
  private supervisorBinary: string | null = null;
  private installing = false;

  constructor(
    private home: NativeHome,
    // WHY: `userDataDir` is a plain constructor param, not a private property —
    // it's used once to seed EngineAcquisition and never read again. The
    // `private` modifier was storing a dead reference on every instance.
    userDataDir: string,
    private port: number,
    /** Test seams (spec §5: mocked subprocess + fetch). `probeChip` stands in
     *  for the graphics-chip probe so a test can drive its FAILURE path — the
     *  real one asks the machine, and a machine cannot be made to fail. */
    private opts: {
      fetchImpl?: typeof fetch;
      supervisorOpts?: Record<string, unknown>;
      probeChip?: () => Promise<MachineChip>;
    } = {}
  ) {
    super();
    // The third argument matters: acquisition fills in the device list of an
    // engine installed before that list existed, in the background, because
    // status() is synchronous and cannot wait on a spawned process. status() is
    // also PULL-only, so without this push a user upgrading from an older build
    // would keep seeing the wrong "runs on" line until some unrelated engine
    // event happened to refetch it.
    this.acquisition = new EngineAcquisition(
      path.join(userDataDir, 'engine'), opts.fetchImpl, () => this.emit('status-changed'),
    );
  }

  /** The usable install, resolved with the CONFIGURED backend preference so a
   *  leftover non-booting build (e.g. a vulkan dir after a CPU fallback) can't
   *  shadow the one that actually works (see EngineAcquisition.installed). */
  private currentInstall(): InstalledEngine | null {
    return this.acquisition.installed(readEngineConfig(this.home).backend ?? undefined);
  }

  /** The chip probe's answer, once. WHY it is not simply computed inside
   *  status(): finding out means ASKING THE MACHINE — running `nvidia-smi`, a
   *  PowerShell query against the display-driver registry, and `ldconfig` — and
   *  every one of those can take a moment, or a long moment if a graphics
   *  driver is wedged (the Windows probes are capped at four seconds EACH).
   *  status() is called on every engine event and on every status request from
   *  the screen, and it is synchronous, so doing that work inside it would
   *  freeze the whole window each time.
   *
   *  So: the first status() answers instantly with `backendOptions` simply
   *  absent, the asking happens on the next tick, and the 'status-changed' push
   *  delivers the answer a moment later. `chipProbing` makes it happen exactly
   *  once per app run — which is correct, because the chip cannot change.
   *
   *  The push MUST fire on the failure path too. It is the only thing that ever
   *  delivers that field, so a missed one leaves the card waiting forever for a
   *  second status that never comes — which looks exactly like a hung app. */
  private chip: MachineChip | null = null;
  private chipProbing = false;

  private warmChip(): void {
    if (this.chip || this.chipProbing) return;
    this.chipProbing = true;
    const probe = this.opts.probeChip ?? probeMachineChip;
    setImmediate(() => {
      void (async () => {
        try {
          this.chip = await probe();
        } catch {
          // A probe that throws still has to SETTLE: "no chip we recognise", so
          // the push below carries a real answer instead of nothing.
          this.chip = { vendor: null, gfxTarget: null };
        }
        this.chipProbing = false;
        // Deliberately outside the try/catch, and after the assignment: this one
        // line is what the card is waiting on, on both paths.
        this.emit('status-changed');
      })();
    });
  }

  /** Which faster builds to offer RIGHT NOW. Recomputed on every status() from
   *  the cached chip plus the two things that do change: which backend is
   *  installed (so a switch is never offered back to itself) and whether the
   *  ROCm libraries are present (the user may have just installed them — the
   *  card's "Check again" refreshes that same reading). Undefined until the
   *  chip probe has answered. */
  private currentBackendOptions(inst: InstalledEngine | null): BackendOption[] | undefined {
    const chip = this.chip;
    if (!chip) return undefined;
    return backendOptions({
      platform: process.platform,
      arch: process.arch,
      vendor: chip.vendor,
      gfxTarget: chip.gfxTarget,
      installedBackend: inst?.backend ?? null,
      // Free: the chip probe primed this cache on its own tick, and it is only
      // ever consulted on an AMD machine.
      rocmPrereqsSatisfied: chip.vendor === 'amd' ? checkRocmPrereqs().satisfied : false,
    });
  }

  /** The compute devices the installed engine reported at install time, exactly
   *  as its `.complete` marker recorded them (design §A2: `llama-server
   *  --list-devices`). The memory estimator scores a model against the FIRST
   *  GPU device's pool, which is the only number that says what this machine's
   *  graphics chip will really hold.
   *
   *  Null for an install whose marker predates that field — which is every
   *  install until the acquisition change ships. That is a fallback, not an
   *  error: fit-estimator.ts then scores against detected VRAM or total RAM and
   *  never claims a model "fits on your GPU" on evidence it does not have. */
  installedDevices(): unknown {
    const inst = this.currentInstall();
    if (!inst) return null;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(inst.dir, '.complete'), 'utf8'));
      return marker?.devices ?? null;
    } catch { return null; }
  }

  status(): EngineStatus {
    const cfg = readEngineConfig(this.home);
    const inst = this.currentInstall();
    const supState = this.supervisor?.status() ?? 'stopped';
    this.warmChip();
    return {
      // Undefined (not []) until the chip probe has answered once. Both fields
      // are recomputed here rather than cached, so installing an engine or
      // switching backend is reflected in the very next status.
      backendOptions: this.currentBackendOptions(inst),
      deviceName: deviceNameOf(inst),
      installed: inst !== null,
      installedVersion: inst?.version ?? null,
      pinnedVersion: ENGINE_VERSION,
      backend: inst?.backend ?? null,
      state: inst === null ? 'not-installed' : supState,
      errorMessage: supState === 'error'
        ? 'The engine crashed repeatedly and was stopped. Press "Restart engine" to try again.'
        : undefined,
      cacheDir: cfg.cacheDir,
      contextSize: cfg.contextSize,   // Plan C: the knob binds to this value
      port: this.port,
    };
  }

  /** Plan C (Amendment I): the context-length knob. Persists the new -c and
   *  reboots a running engine so the change takes effect immediately. */
  async setContext(contextSize: number): Promise<void> {
    if (!Number.isFinite(contextSize) || contextSize < 1024) {
      throw new Error('Context length must be at least 1024 tokens.');
    }
    await updateEngineConfig(this.home, { contextSize: Math.floor(contextSize) });
    // A running engine keeps its old -c until rebooted; restart now so the knob
    // does what it says. The supervisorBinary = null is REQUIRED (K6):
    // rebuildSupervisor dedups on binaryPath, so a plain restart() would return
    // early and keep the OLD contextSize — nulling forces a rebuild with the
    // fresh config on the next ensureRunning. stop() is single-flight (Plan B),
    // so a send in the kill window is coordinated; only avoid applying this
    // mid-stream (a context change is inherently disruptive).
    if (this.supervisor) { await this.supervisor.stop(); this.supervisorBinary = null; }
    this.emit('status-changed');
  }

  /** Install the pinned engine for this machine. Vulkan-first on win/linux
   *  with an automatic CPU fallback when the Vulkan build won't BOOT (spec
   *  §3.1) — the fallback is decided by a real verify-boot, not GPU sniffing.
   *  Progress rides the 'install-progress' event. */
  async install(): Promise<void> {
    if (this.installing) throw new Error('An engine install is already running.');
    this.installing = true;
    const onProgress = (p: EngineInstallProgress) => this.emit('install-progress', p);
    try {
      const cfg = readEngineConfig(this.home);
      const preferred = cfg.backend ?? defaultBackend(process.platform);
      const sel = selectInstallAsset(process.platform, process.arch, preferred);
      if (!sel) {
        throw new Error(`Local models are not available for this platform yet (${process.platform}/${process.arch}).`);
      }
      const { asset, backend } = sel;
      let bootedBackend: EngineBackend = backend;
      let installed: InstalledEngine;
      try {
        installed = await this.installAndVerify(asset, onProgress);
      } catch (bootErr) {
        // Vulkan build won't start (no/old driver, headless box) → one CPU
        // retry. Only reached when we started on vulkan; the missing-asset
        // drop in selectInstallAsset already used cpu when there was no choice.
        const cpuAsset = backend === 'vulkan' ? pickAsset(process.platform, process.arch, 'cpu') : null;
        if (!cpuAsset) throw bootErr;
        installed = await this.installAndVerify(cpuAsset, onProgress);
        bootedBackend = 'cpu';
      }
      // Record the booted backend when it differs from the platform default
      // (a missing-asset drop OR a vulkan→cpu boot fallback) so status()/
      // installed() resolve to the build that actually works — never the
      // leftover non-booting one. cfg is only touched AFTER a successful boot.
      if (bootedBackend !== defaultBackend(process.platform)) {
        await updateEngineConfig(this.home, { backend: bootedBackend });
      }
      // Only now, with a booted replacement in hand, is the old engine garbage.
      // installed() prefers the pinned version anyway, so anything else on disk
      // is unreachable weight rather than a fallback.
      this.acquisition.pruneOthers(installed);
      this.emit('status-changed');
    } catch (e: any) {
      onProgress({ kind: 'error', message: e?.message ?? String(e) });
      this.emit('status-changed');
      throw e;
    } finally {
      this.installing = false;
    }
  }

  /** Install an asset and prove it RUNS, undoing the install if it does not.
   *
   *  The undo is the whole point: acquisition.install() marks a directory complete
   *  and moves it into place before anything executes the binary, and installed()
   *  prefers the pinned version over every other — so a downloaded-but-unrunnable
   *  engine silently replaces a working one. Discarding it here restores the
   *  previous engine as the newest USABLE install, which is what installed()
   *  resolves to on the next call. The supervisor is dropped too: verifyBoot
   *  pointed it at the binary we just deleted. */
  private async installAndVerify(
    asset: EngineAsset, onProgress: (p: EngineInstallProgress) => void,
  ): Promise<InstalledEngine> {
    // Only an install THIS call created may be discarded. acquisition.install()
    // is idempotent — handed a version+backend already on disk it returns it
    // untouched — so pressing Install on the engine you are already running
    // reaches verifyBoot too, and a transient boot failure there (a busy port,
    // a driver hiccup) must not delete a build that has been working for weeks.
    const dir = this.acquisition.installDir(ENGINE_VERSION, asset.backend);
    const preexisting = fs.existsSync(path.join(dir, '.complete'));
    const installed = await this.acquisition.install(asset, onProgress);
    try {
      await this.verifyBoot(installed);
      return installed;
    } catch (bootErr) {
      if (!preexisting) {
        if (this.supervisor) { try { await this.supervisor.stop(); } catch { /* already dead */ } }
        this.supervisor = null;
        this.supervisorBinary = null;
        this.acquisition.discard(installed);
      }
      throw bootErr;
    }
  }

  /** Bring the engine up to the pinned version at app launch, in the background.
   *
   *  WHY automatic: a new model architecture only becomes runnable when llama.cpp
   *  learns to read it, and a user has no way to know that a model that "won't
   *  load" needs a newer engine. Holding everyone at the version they first
   *  installed makes every future model release look like a broken app.
   *
   *  Deliberately NOT a first install. With no engine on disk this returns
   *  immediately: pulling a few hundred MB on first launch, for a feature the user
   *  may never touch, is not ours to decide — that stays the Install button.
   *
   *  Never throws and never blocks startup. Every failure path (offline, metered,
   *  a build that will not boot here) leaves the working engine exactly as it was;
   *  the manual Update button in Settings is still there to retry. */
  async autoUpdateOnLaunch(): Promise<void> {
    try {
      const inst = this.currentInstall();
      if (!inst) return;                          // no engine yet — first install stays a user action
      if (inst.version === ENGINE_VERSION) return; // already current
      if (this.installing) return;                 // a manual install is already running
      // Swapping the binary stops the running engine, which unloads whatever model
      // is resident — minutes of reload for a large one. At launch nothing should
      // be running yet, but a session restored fast enough could have started it,
      // and the next launch will pick the update up anyway.
      if (this.supervisor && this.supervisor.status() !== 'stopped') return;
      await this.install();
      // Leave the engine exactly as this method found it: STOPPED. install()
      // deliberately leaves it running (someone who just pressed Install wants to
      // use it), but nobody asked for this one — and without the stop, the first
      // launch after an engine bump would silently start a llama-server that
      // previously only appeared on the first message. An unexplained new process
      // at startup is the kind of change a user cannot trace back to anything.
      if (this.supervisor) await this.supervisor.stop();
      this.emit('status-changed');
    } catch {
      // Swallowed on purpose: this is unattended background work the user did not
      // ask for, so it must never surface an error they cannot act on. install()
      // has already emitted an install-progress 'error' for anyone watching the
      // Settings card, and installAndVerify has restored the previous engine.
    }
  }

  /** Boot the engine once and wait for /health — proves the build runs on this
   *  machine. The engine is LEFT RUNNING (the user installed it to use it;
   *  idle shutdown reaps it if not). */
  private async verifyBoot(installed: InstalledEngine): Promise<void> {
    await this.rebuildSupervisor(installed);
    await this.supervisor!.ensureRunning();
  }

  private async rebuildSupervisor(installed: InstalledEngine): Promise<void> {
    if (this.supervisor && this.supervisorBinary === installed.binaryPath) return;
    if (this.supervisor) await this.supervisor.stop();
    const cfg = readEngineConfig(this.home);
    this.supervisor = new EngineSupervisor({
      binaryPath: installed.binaryPath,
      port: this.port,
      cacheDir: cfg.cacheDir,
      contextSize: cfg.contextSize,
      fetchImpl: this.opts.fetchImpl,
      ...(this.opts.supervisorOpts ?? {}),
    });
    this.supervisorBinary = installed.binaryPath;
    // Fan out supervisor transitions so the EngineCard tracks crash/idle live.
    this.supervisor.on('status-changed', () => this.emit('status-changed'));
    this.supervisor.on('crashed', (info) => this.emit('crashed', info));
    // Fan out per-model residency (load/sleep/unload) → the model-state
    // coordinator turns this into per-session banners (unloaded/loading UI).
    this.supervisor.on('models-changed', (models) => this.emit('models-changed', models));
  }

  /** Best-effort per-model unload — used when the last session bound to a model
   *  goes away (frees its memory immediately, ahead of the 5-min sleep). */
  async unloadModel(modelId: string): Promise<void> {
    if (!this.supervisor) return;
    await this.supervisor.unloadModel(modelId);
  }

  /** Force a model resident (the [Reload Model] button). Boots the engine if
   *  needed, then warms the model so its state flips loading → loaded.
   *  ensureServable first: this is the pick-time safety net for a GGUF that
   *  reached --models-dir after the router booted (download finished with the
   *  app closed, a file copied in by hand, a refresh that failed). Without it
   *  the warm-up 400s and the user's first send is what tells them. */
  async loadModel(modelId: string): Promise<void> {
    const inst = this.currentInstall();
    if (!inst) throw new Error('The local engine is not installed yet.');
    await this.rebuildSupervisor(inst);
    await this.supervisor!.ensureServable(modelId);
    await this.supervisor!.loadModel(modelId);
  }

  /** Make the running router re-scan --models-dir. Called after a download lands
   *  and after a delete, so the router's model set matches the disk. No-op when
   *  the engine is stopped — its next boot scans the dir anyway. */
  async refreshModels(): Promise<void> {
    if (!this.supervisor) return;
    await this.supervisor.refreshModels();
    this.emit('status-changed');
  }

  /** True when the router can actually SERVE `modelId` right now. Fails OPEN
   *  (see EngineSupervisor.ensureServable) — a false is a positive "the router
   *  listed its models and yours was not among them", safe to act on. */
  async ensureServable(modelId: string): Promise<boolean> {
    if (!this.supervisor) return true;
    return this.supervisor.ensureServable(modelId);
  }

  /** Live per-model residency for the create-time memory guard + coordinator. */
  async liveModels(): Promise<EngineModel[]> {
    const inst = this.currentInstall();
    if (!inst) return [];
    await this.rebuildSupervisor(inst);
    return this.supervisor!.listModels();
  }

  /** User-initiated recovery: clear the strike-out and boot fresh. */
  async restart(): Promise<void> {
    const inst = this.currentInstall();
    if (!inst) throw new Error('The local engine is not installed yet.');
    await this.rebuildSupervisor(inst);
    this.supervisor!.resetStrikes();
    await this.supervisor!.stop();
    await this.supervisor!.ensureRunning();
  }

  registryHook(): LocalEngineHook {
    return {
      installed: () => this.currentInstall() !== null,
      ensureRunning: async () => {
        const inst = this.currentInstall();
        if (!inst) {
          throw new Error('Local models need a one-time engine install — open Settings → Providers and press Install.');
        }
        await this.rebuildSupervisor(inst);
        return this.supervisor!.ensureRunning();
      },
      ensureServable: async (modelId: string) => this.ensureServable(modelId),
      // Bound lazily: the supervisor may not exist yet when the registry is
      // constructed; by the time the AI SDK fetches, ensureRunning built it.
      fetchImpl: () => (input: any, init?: any) => {
        if (!this.supervisor) return (this.opts.fetchImpl ?? fetch)(input, init);
        return this.supervisor.trackedFetch(input, init);
      },
    };
  }

  /** Local rows for ModelCatalog.get(). contextLength is the CONFIGURED -c —
   *  the engine truncates there regardless of the model's trained max, and
   *  HarnessSession sizes its history window from this number. */
  async catalogModels(): Promise<CatalogModel[]> {
    const inst = this.currentInstall();
    if (inst === null) return [];
    const cfg = readEngineConfig(this.home);
    await this.rebuildSupervisor(inst);
    const models = await this.supervisor!.listModels();
    return models.map((m) => ({
      id: m.id,
      providerId: 'local',
      // The id stays the raw first-part filename (that IS the engine's address
      // for the whole set); only the label drops the -00001-of-00004 marker, so
      // one split model reads as one model in the picker.
      label: stripSplitSuffix(m.id),
      contextLength: cfg.contextSize,
      local: { sizeBytes: m.sizeBytes ?? 0, quant: 'unknown', installed: true, state: m.state },
    }));
  }

  /** The REAL context window HarnessSession should size its history + compaction
   *  from for a local model: the minimum of what llama-server actually loaded
   *  (its /props n_ctx) and the model's GGUF-trained max. This replaces trusting
   *  the configured -c blindly — a small model overflows if we size to a -c larger
   *  than its trained ceiling. Boots the engine if needed (single-flight; it would
   *  boot on the first send anyway) to read the live number. NEVER throws — a
   *  status read must not break session create; on any failure we return the same
   *  conservative default clampContextWindow uses.
   *
   *  Task 13 fix pass: also returns `totalSlots` (llama-server's n_slots) —
   *  the local concurrency cap needs this, and it lives in the exact same
   *  /props response this function already fetches. Folding it into this one
   *  return value (rather than a second method with its own fetch) is WHY
   *  reading both costs exactly one HTTP round trip: fix pass 2 threads this
   *  whole object straight through ipc-handlers.ts's single contextAndSlotsFor
   *  closure into NativeSessionHost — there is no separate slot-count call and
   *  no variable sharing one reading between two closures. */
  async effectiveContextWindow(modelId: string): Promise<{ contextLength: number; totalSlots: number | null }> {
    try {
      const inst = this.currentInstall();
      // Engine not installed yet → no live number to read; fall through to the
      // trained max (also null today) → conservative default. No engine means
      // no slot count either — totalSlots is unknown, not zero.
      if (!inst) return { contextLength: clampContextWindow(null, this.trainedContextFor(modelId)), totalSlots: null };
      await this.rebuildSupervisor(inst);
      await this.supervisor!.ensureRunning();
      // /props is a llama-server management endpoint at ROOT (not the /v1 OpenAI
      // namespace) — same 127.0.0.1:port convention as /models and /health. Plain
      // fetch, not trackedFetch: a status read must not bump the idle-shutdown clock.
      const res = await (this.opts.fetchImpl ?? fetch)(`http://127.0.0.1:${this.port}/props`, { method: 'GET' });
      const props: any = await res.json();
      // The field carrying the loaded context has drifted across llama.cpp builds
      // (default_generation_settings.n_ctx vs a top-level n_ctx) — read both.
      const loadedRaw = props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null;
      // Task 13 fix pass: n_slots rides the SAME response body — see
      // resolveSlotCount's own comment for why an absent/zero/non-numeric
      // reading resolves to null ("unknown") rather than a guessed count.
      const totalSlots = resolveSlotCount(props?.n_slots);
      const trained = this.trainedContextFor(modelId);
      // Fall back to the -c WE spawned the server with, not a blind constant.
      //
      // WHY (found 2026-07-26 dogfooding): in `--models-dir` ROUTER mode — the
      // default — /props answers `{model_path: "none", n_ctx: 0}` whenever no
      // model is currently resident. clampContextWindow discards any value <= 0,
      // so it fell through to its hardcoded 32_768 and every local session
      // believed it had half the window it was actually given. A read of
      // ROADMAP.md that fits comfortably in 64k then overflowed a phantom 32k
      // budget and killed the turn ("messages must not be empty").
      //
      // The configured contextSize is strictly better than a constant: it is the
      // exact number this app passed to llama-server on the command line, so it
      // is right whenever /props is merely UNINFORMATIVE. A live /props reading
      // still wins when present — it catches the case where the server clamped
      // our -c down to what the model or VRAM actually allowed.
      //
      // ADDRESSING this function's own doc comment above ("replaces trusting the
      // configured -c blindly — a small model overflows if we size to a -c larger
      // than its trained ceiling"): that concern is real but it does NOT argue for
      // the old behavior, because the constant it fell back to was 32_768 — itself
      // far larger than the 4k-trained model the warning describes. The old default
      // over-sized that model too; it just over-sized everything else DOWNWARD as
      // well. Three things bound the risk here:
      //   - /props only reports 0 when NOTHING is resident. Once a model loads, the
      //     live reading wins and any server-side clamp is respected.
      //   - effectiveContextForModel then clamps to the registry's documented
      //     maxContextWindow for every known family.
      //   - trainedContextFor() is inert today (no GGUF header reader), so the
      //     "trained max" guard the comment relies on provides nothing either way.
      // Closing the gap properly means parsing <arch>.context_length from the GGUF
      // — tracked as the trainedContextFor TODO below, not solved by guessing low.
      const configured = readEngineConfig(this.home).contextSize ?? null;
      return { contextLength: resolveEffectiveContext(loadedRaw, configured, trained), totalSlots };
    } catch {
      // Same reasoning on the error path — prefer our own -c over a guess.
      // A failed read (network error, bad JSON, no supervisor) means the slot
      // count is unknown too — never guess a number here either.
      try {
        return { contextLength: resolveEffectiveContext(null, readEngineConfig(this.home).contextSize ?? null, null), totalSlots: null };
      } catch {
        return { contextLength: 32_768, totalSlots: null };
      }
    }
  }

  /** The model's GGUF-trained max context, if known. CONCERN: today the cache
   *  scan (scanGgufCache → EngineModel) carries no trained-context field — that
   *  value lives in the GGUF header (<arch>.context_length), which nothing here
   *  parses yet — so this returns null and clampContextWindow falls back to the
   *  loaded /props value alone. When a GGUF-metadata reader lands, surface the
   *  trained max here so a model whose file was trained smaller than the loaded
   *  -c can't be over-driven. */
  private trainedContextFor(_modelId: string): number | null {
    return null;
  }

  /** Plan C: switch GPU backend. Downloads that backend's build if missing
   *  (progress rides the same install-progress event), verifies it boots,
   *  THEN records the choice — a failed switch leaves config untouched. */
  async setBackend(backend: EngineBackend): Promise<void> {
    const asset = pickAsset(process.platform, process.arch, backend);
    if (!asset) {
      throw new Error(`That backend is not available for this platform (${process.platform}/${process.arch}).`);
    }
    const onProgress = (p: EngineInstallProgress) => this.emit('install-progress', p);
    const installed = await this.acquisition.install(asset, onProgress);
    await this.verifyBoot(installed);
    await updateEngineConfig(this.home, { backend });
    this.emit('status-changed');
  }

  /** Plan C: installed models with quant metadata (spec §4.5). lastUsedAt +
   *  defaultForTier were CUT from v1 (Amendment 2026-07-14 G). */
  /** Every download in the cache dir, complete or not, with the state the Local
   *  Models screen renders. Unlike liveModels() this deliberately does NOT
   *  filter incomplete sets — Settings is where you act on them. */
  async installedModels(): Promise<InstalledLocalModel[]> {
    const cacheDir = readEngineConfig(this.home).cacheDir;
    const rows: InstalledLocalModel[] = [];
    for (const d of scanLocalDownloads(cacheDir)) {
      const complete = isComplete(d);
      const manifest = d.hasManifest ? readManifest(cacheDir, d.firstFileName) : null;
      if (complete && d.hasManifest) {
        // WHY this no longer deletes: the manifest OUTLIVES the download now, so
        // one sitting beside a complete set is the normal, wanted state. Two
        // exceptions, both best-effort and never a reason to fail the list:
        // an unreadable fragment is swept, and a readable-but-unstamped manifest
        // is a crash between publishing the last file and stamping it, so it is
        // healed here rather than thrown away — it holds the only record of the
        // repo this model came from.
        if (!manifest) {
          try { removeManifest(cacheDir, d.firstFileName); } catch { /* best-effort */ }
        } else if (!isManifestComplete(manifest)) {
          // CAREFUL, for whoever adds files to a download job (T15): "complete"
          // here is isComplete(d) — the part count read off the FILENAMES
          // (…-00002-of-00003.gguf), not the manifest's own `files` list. That
          // is safe only while `files` holds exactly one quant's split parts,
          // which is all quant-parser.ts ever puts there today. Add a vision
          // projector to the same download job and a Local Models render that
          // lands between the last weight part and the projector would stamp
          // this manifest complete while the job is still running. If `files`
          // grows beyond the split set, this test has to read `files` too.
          try { markManifestComplete(cacheDir, d.firstFileName, Date.now()); } catch { /* best-effort */ }
        }
      }
      // The row's "unfinished" facts come only from a manifest that is still
      // in flight; a stamped one describes a download that already landed.
      const unfinished = !complete && manifest != null && !isManifestComplete(manifest);
      const bytesOnDisk = d.bytesPublished + d.bytesPartial;
      if (!complete && bytesOnDisk === 0 && !unfinished) {
        // Only an unreadable manifest — or one stamped complete whose files are
        // gone — and no bytes: nothing to resume, nothing to delete, nothing to
        // show. Remove the leftover so it cannot accumulate.
        try { removeManifest(cacheDir, d.firstFileName); } catch { /* best-effort */ }
        continue;
      }
      const parsed = parseGgufName(d.firstFileName);
      rows.push({
        id: d.modelId,
        // Bytes on disk. For an unfinished set that includes the .partial, so
        // the delete confirmation names what the user actually gives up.
        sizeBytes: complete ? d.bytesPublished : bytesOnDisk,
        // The manifest's quant is the exact string Hugging Face used — the one
        // live progress events carry, so the renderer can match them to this row.
        quant: (unfinished ? manifest?.quant : undefined) ?? parsed?.quant ?? null,
        quantDescription: parsed ? quantDescription(parsed.quant) : null,
        parts: d.partsDeclared,
        status: complete ? 'complete' : unfinished ? 'unfinished' : 'untraceable',
        partsPresent: d.partsPresent,
        totalSizeBytes: unfinished ? manifest!.totalSizeBytes : null,
        // A COMPLETE row still reports no repo, exactly as before this change —
        // the manifest surviving does not by itself change what the screen
        // shows. T14/T15 must flip this, because Add vision needs the repo, and
        // the flip is NOT free: LocalModelsSection matches a live download's
        // progress events to a row on repo + quant, so a finished model that
        // starts reporting a repo can absorb progress belonging to a different,
        // still-running download of the same repo and quant.
        repo: unfinished ? manifest!.repo : null,
      });
    }
    return rows;
  }

  // noteModelUsed / setDefaultForTier were CUT from v1 (Amendment 2026-07-14 G).
  // Do NOT reintroduce until the model picker actually consumes a per-tier
  // default — a write-only stat would just be dead state.

  /** Plan C: delete a model (all parts). Best-effort /models/unload first so
   *  the router isn't serving a file we're removing; file deletion proceeds
   *  regardless (the router tolerates a vanished file on next request). */
  async deleteModel(id: string): Promise<void> {
    const cfg = readEngineConfig(this.home);
    if (this.supervisor?.status() === 'running') {
      try {
        await (this.opts.fetchImpl ?? fetch)(`http://127.0.0.1:${this.port}/models/unload`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: id }),
        });
      } catch { /* best-effort */ }
    }
    // A multi-part id points at part 00001 — delete every sibling part.
    const partMatch = /-(\d{5})-of-(\d{5})$/.exec(id);
    const names = partMatch
      ? Array.from({ length: Number(partMatch[2]) }, (_, i) =>
          `${id.replace(/-\d{5}-of-\d{5}$/, '')}-${String(i + 1).padStart(5, '0')}-of-${partMatch[2]}.gguf`)
      : [`${id}.gguf`];
    for (const name of names) {
      fs.rmSync(path.join(cfg.cacheDir, name), { force: true });
      fs.rmSync(path.join(cfg.cacheDir, `${name}.partial`), { force: true });
    }
    // The manifest describes files that no longer exist — remove it with them.
    removeManifest(cfg.cacheDir, `${id}.gguf`);
    // Tell the router the file is gone, or it keeps advertising a model that
    // 400s on use — the delete-side twin of the post-download refresh.
    await this.refreshModels();
    this.emit('status-changed');
  }

  /** App-quit teardown — registered next to nativeHost.destroyAll(). */
  async stopAll(): Promise<void> {
    if (this.supervisor) await this.supervisor.stop();
  }
}
