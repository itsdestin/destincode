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
import { scanGgufCache } from './cache-scan';
import { parseGgufName, quantDescription } from '../models/quant-parser';
import type {
  EngineBackend, EngineInstallProgress, EngineStatus, EngineModel,
} from '../../shared/engine-types';
import type { CatalogModel } from '../../shared/provider-types';
import type { InstalledLocalModel } from '../../shared/model-manager-types';

/** What ProviderRegistry's local-engine branch consumes (replaces Plan A's
 *  bare localBaseUrl callback). Defined here, imported by provider-registry. */
export interface LocalEngineHook {
  installed(): boolean;
  ensureRunning(): Promise<string>;   // OpenAI-compatible base URL (…/v1)
  fetchImpl(): typeof fetch;          // supervisor.trackedFetch — idle accounting sees every request
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

export class EngineManager extends EventEmitter {
  private acquisition: EngineAcquisition;
  private supervisor: EngineSupervisor | null = null;
  private supervisorBinary: string | null = null;
  private installing = false;

  constructor(
    private home: NativeHome,
    private userDataDir: string,
    private port: number,
    /** Test seams (spec §5: mocked subprocess + fetch). */
    private opts: { fetchImpl?: typeof fetch; supervisorOpts?: Record<string, unknown> } = {}
  ) {
    super();
    this.acquisition = new EngineAcquisition(path.join(userDataDir, 'engine'), opts.fetchImpl);
  }

  /** The usable install, resolved with the CONFIGURED backend preference so a
   *  leftover non-booting build (e.g. a vulkan dir after a CPU fallback) can't
   *  shadow the one that actually works (see EngineAcquisition.installed). */
  private currentInstall(): InstalledEngine | null {
    return this.acquisition.installed(readEngineConfig(this.home).backend ?? undefined);
  }

  status(): EngineStatus {
    const cfg = readEngineConfig(this.home);
    const inst = this.currentInstall();
    const supState = this.supervisor?.status() ?? 'stopped';
    return {
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
      const installed = await this.acquisition.install(asset, onProgress);
      let bootedBackend: EngineBackend = backend;
      try {
        await this.verifyBoot(installed);
      } catch (bootErr) {
        // Vulkan build won't start (no/old driver, headless box) → one CPU
        // retry. Only reached when we started on vulkan; the missing-asset
        // drop in selectInstallAsset already used cpu when there was no choice.
        const cpuAsset = backend === 'vulkan' ? pickAsset(process.platform, process.arch, 'cpu') : null;
        if (!cpuAsset) throw bootErr;
        const cpuInstalled = await this.acquisition.install(cpuAsset, onProgress);
        await this.verifyBoot(cpuInstalled);
        bootedBackend = 'cpu';
      }
      // Record the booted backend when it differs from the platform default
      // (a missing-asset drop OR a vulkan→cpu boot fallback) so status()/
      // installed() resolve to the build that actually works — never the
      // leftover non-booting one. cfg is only touched AFTER a successful boot.
      if (bootedBackend !== defaultBackend(process.platform)) {
        await updateEngineConfig(this.home, { backend: bootedBackend });
      }
      this.emit('status-changed');
    } catch (e: any) {
      onProgress({ kind: 'error', message: e?.message ?? String(e) });
      this.emit('status-changed');
      throw e;
    } finally {
      this.installing = false;
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
   *  needed, then warms the model so its state flips loading → loaded. */
  async loadModel(modelId: string): Promise<void> {
    const inst = this.currentInstall();
    if (!inst) throw new Error('The local engine is not installed yet.');
    await this.rebuildSupervisor(inst);
    await this.supervisor!.loadModel(modelId);
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
      label: m.id,
      contextLength: cfg.contextSize,
      local: { sizeBytes: m.sizeBytes ?? 0, quant: 'unknown', installed: true, state: m.state },
    }));
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
  async installedModels(): Promise<InstalledLocalModel[]> {
    const cfg = readEngineConfig(this.home);
    return scanGgufCache(cfg.cacheDir).map((m) => {
      const parsed = parseGgufName(`${m.id}.gguf`);
      return {
        id: m.id,
        sizeBytes: m.sizeBytes ?? 0,   // scanGgufCache sums all parts for a split model
        quant: parsed?.quant ?? null,
        quantDescription: parsed ? quantDescription(parsed.quant) : null,
        parts: parsed?.part?.of ?? 1,
      };
    });
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
    this.emit('status-changed');
  }

  /** App-quit teardown — registered next to nativeHost.destroyAll(). */
  async stopAll(): Promise<void> {
    if (this.supervisor) await this.supervisor.stop();
  }
}
