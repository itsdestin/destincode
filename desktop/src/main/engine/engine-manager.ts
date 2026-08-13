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
   *  the ipc-handlers.ts wiring's local concurrency cap needs this, and it
   *  lives in the exact same /props response this function already fetches.
   *  Folding it into this return value (rather than a second method with its
   *  own fetch) is WHY the two never cost a second HTTP round trip: whichever
   *  caller reads contextLength first captures totalSlots for free, and the
   *  ipc-handlers wiring hands that captured value to the separate
   *  slotCountFor closure instead of querying the engine again. */
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
