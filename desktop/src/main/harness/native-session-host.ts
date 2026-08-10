// NativeSessionHost (Phase 1 Plan A, Task 9) — the registry of live
// HarnessSessions plus the persistence glue that turns their transcript-event
// stream into (a) forwarded renderer/remote events and (b) coalesced on-disk
// records. It is the ONE place the two serialization contracts from earlier
// tasks are honored:
//   1. HarnessSession.send() is not re-entrant — the host only calls send()
//      once per user turn and never overlaps turns for a session.
//   2. SessionStore.append() must be serialized per session — the host runs
//      appends on a per-session promise chain (never fire-and-forget), so two
//      events for the same session can't interleave their file writes.
//
// KEY DESIGN CHOICE — persist-alongside, not persist-before-forward: when an
// event arrives we forward it to the renderer SYNCHRONOUSLY (UI latency must
// not wait on disk) AND enqueue the append on the per-session chain. A renderer
// crash losing an unpersisted event is acceptable; a stuttering UI is not.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { TranscriptEvent, NativeSendResult } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import { HarnessSession, type ModelFactory, type HarnessSessionOpts } from './harness-session';
import { rebuildHistory } from './history-rebuild';
import { SessionStore, type NativeSessionListEntry } from './session-store';
import { PermissionBroker, type AskDecision } from './permission-broker';
import { resolvePreset, type ResolvedPreset } from './preset-registry';
import { decidePermission } from './permission-engine';
import { rulesForMode, DESTRUCTIVE_DENY_LIST, type NativePermissionMode, type PermissionRule } from '../../shared/permission-types';
import { assembleSystemPrompt } from './prompt-assembly';
import { resolveProfile, effectiveContextForModel, type CapabilityProfile, type ProfileProviderType } from './capability-profile';
import { CORE_TOOLS } from './tools';
import type { ToolServices } from './tools/types';
import { createSkillCatalog, type SkillCatalog } from './skills/skill-catalog';
import { fitInjection } from './injection/injection-budget';
import { frameSkillInvocation } from './skills/skill-invocation';
import { buildTriggerIndex } from './injection/path-triggers';
import { log } from '../logger';
import type { McpLease } from './mcp/mcp-manager';

export interface CreateNativeSessionOpts {
  sessionId: string;
  cwd: string;
  binding: ModelBinding;
  presetId?: string;
}

/** The two PermissionStore methods the host consumes. Declared structurally so
 *  tests can inject a real PermissionStore (which satisfies this shape) OR rely
 *  on the no-op default below without pulling in the NativeHome dependency. */
export interface RememberedRuleStore {
  rulesFor(cwd: string): Promise<PermissionRule[]>;
  remember(cwd: string, rule: PermissionRule): Promise<void>;
}
const NOOP_REMEMBERED_STORE: RememberedRuleStore = {
  async rulesFor() { return []; },
  async remember() { /* no-op */ },
};

// M1 send queue: bounded per program §2.1 — past this many FIFO'd sends, send()
// refuses honestly (status 'failed', reason 'queue-full') instead of accepting
// input the user has no way to know is piling up unseen.
const SEND_QUEUE_LIMIT = 10;

interface LiveEntry {
  session: HarnessSession;
  cwd: string;
  // This generation's MCP lease (undefined when no manager is wired, or when
  // acquireMcp() caught a whole-registry failure). It lives HERE, on the live
  // entry, rather than in a sessionId-keyed map on the host.
  //
  // BE HONEST ABOUT WHY. This is structural insurance, NOT a fix for a bug
  // observable today — a sessionId-keyed side map was tried as a mutation and
  // no test could tell the difference, because it genuinely behaves the same
  // right now. Two things make it equivalent: resume() awaits any live
  // destroy() for the same id before acquiring, and destroy() has no await
  // between `this.live.delete()` and the release call below, so nothing can
  // interleave and swap the lease out. Both are properties of code that could
  // change. Reading the lease off the entry destroy() already captured — at
  // its top, before any await — makes "release the generation you are tearing
  // down" true by construction rather than by that pair of coincidences, which
  // is the same discipline McpLease applies inside the manager (where the
  // equivalent bug WAS reachable and is mutation-tested).
  mcpLease?: McpLease;
  // Per-session append serialization: each transcript event extends this chain
  // (append(prev).then(next)) so the SessionStore contract (serialized appends)
  // holds. Starts resolved; a failed append is logged but never breaks the
  // chain (a later append must still run).
  appendChain: Promise<void>;
  // M1 send queue: FIFO of user messages that arrived while a turn was in
  // flight. Drained one at a time by runTurns; dropped with the entry on destroy.
  // Task 11 (cancel/edit queued messages): each entry carries a host-minted id
  // (send()'s randomUUID()) so removeQueued() can target one entry precisely —
  // the id is opaque to the drain loop, which only ever consumes the FRONT via
  // shift() (see runTurns), so a removed entry can never be shifted out and sent.
  queue: { id: string; text: string }[];
  // True from dispatch until runTurns finishes the last queued turn. Host-owned
  // (HarnessSession's in-flight state is private); safe because Node is single-threaded.
  inFlight: boolean;
  // Awaitable handle on the CURRENT drain (the dispatched turn + any queued
  // follow-ups it drains). Set by send() at dispatch; resolves when runTurns
  // exits (runTurns try/catches its send() so this never rejects). undefined
  // when no turn has ever been dispatched, or resolved after the last one ended.
  // quiesce()/teardown await this to know the in-flight turn has actually settled
  // — the host has no other awaitable handle on the fire-and-forget runTurns.
  running?: Promise<void>;
}

export class NativeSessionHost extends EventEmitter {
  private live = new Map<string, LiveEntry>();
  // Reverse index: modelId → sessionIds currently bound to it. The ONLY
  // session→model usage tracking in the app. Drives "unload a model when no
  // session is using it" (#1) — when a model's set empties, onModelReleased
  // fires so the engine can free it immediately (ahead of the 5-min sleep).
  private modelRefs = new Map<string, Set<string>>();
  private onModelReleased?: (modelId: string) => void;

  // One broker for all native sessions (spec §2.4). Its 'hook-event's are
  // re-emitted on this host so ipc-handlers forwards them on the SAME channel
  // as native transcript events (which is the SAME channel CC hook events ride).
  private broker = new PermissionBroker();

  // Per-session permission mode (spec §2.4 layer 2). In-memory, per session,
  // default 'ask' — NOT persisted (a fresh app session starts back at 'ask').
  // decide() reads this fresh on every tool, so setPermissionMode() takes effect
  // on the NEXT gated call without disturbing an in-flight ask.
  private modeFor = new Map<string, NativePermissionMode>();

  // Per-session in-memory copy of "Always allow" rules remembered THIS session.
  // WHY memory is the source of session-truth: the disk persist (PermissionStore)
  // is async fire-and-forget, so relying on it alone means (a) a failed persist
  // silently never sticks — the user re-asks forever — and (b) a fast model's
  // next tool can race the write and re-ask once. Updated SYNCHRONOUSLY in the
  // remember-rule handler (before the async persist kicks off) and unioned into
  // decide(), so an Always-allow always sticks for the rest of this session.
  // Disk remains the cross-session record; this is per-run and dropped on destroy.
  private rememberedFor = new Map<string, PermissionRule[]>();

  // Per-session resolved preset id (POST legacy-mapping, e.g. a stored 'chat'
  // header resolves to 'assistant' here). Drives the renderer's preset chip and
  // is the read-side answer to "what personality is this session running as".
  private presetIdFor = new Map<string, string>();   // resolved (post-legacy-mapping) preset id

  /** This session's current permission mode (default 'ask' when not seeded). */
  getPermissionMode(sessionId: string): NativePermissionMode { return this.modeFor.get(sessionId) ?? 'ask'; }
  /** This session's resolved preset id (null if not live). */
  getHarnessId(sessionId: string): string | null { return this.presetIdFor.get(sessionId) ?? null; }

  constructor(
    private store: SessionStore,
    private modelFactory: ModelFactory,
    private contextLengthFor: (binding: ModelBinding) => Promise<number | null>,
    // Resolves a binding's provider TYPE (local-engine / openrouter / anthropic /
    // …) so the host can pick the right CapabilityProfile (Task 5). A binding
    // whose provider is unknown returns null → resolveContextAndProfile falls back
    // to a cloud-safe default. Positioned right after contextLengthFor because the
    // two are resolved together for every create/resume/swap.
    private providerTypeFor: (binding: ModelBinding) => Promise<ProfileProviderType | null>,
    // Remembered "Always allow" rules, scoped per project (Task 12). Defaults to
    // a no-op so the many existing 3-arg test constructions still compile; the
    // real wiring (ipc-handlers) injects a PermissionStore over ~/.youcoded/.
    private permissionStore: RememberedRuleStore = NOOP_REMEMBERED_STORE,
    // Injected because electron's `app` is not importable in tests (mirrors the
    // other injected functions/values above). Feeds the <env> block of the
    // once-per-session assembled system prompt.
    private appVersion: string = '0.0.0-dev',
    // Runtime services threaded into every session's ToolContext (spec §3.2) —
    // WebSearch reads toolServices.search. Optional + LAST so existing 3/4/5-arg
    // test constructions still compile; the real wiring (ipc-handlers) injects
    // { search: searchService }.
    private toolServices?: ToolServices,
    // Installed-skill source for /skill-name and the Skill tool (M3 item 1).
    // Injected + LAST so existing constructions still compile, and so a test can
    // supply a fake instead of scanning the real ~/.claude — which makes "no
    // skills installed" an expressible state rather than an environment accident.
    private skillCatalog?: SkillCatalog,
    // The process-level MCP connection pool (Task 4, mcp-manager.ts). Optional +
    // LAST so existing constructions still compile. Its destroyAll() was
    // already wired at this host's own app-quit path (destroyAll() below)
    // before this task; Task 6 adds the per-session acquire()/release() calls
    // (create/resume/destroy below). Typed structurally (McpManager's real
    // shape, not the imported class) so tests can inject a fake pool without
    // this file depending on the concrete class for a few method calls.
    // There is deliberately no `release(sessionId)` in this shape: a lease is
    // given back through the object acquire() returns, which is what keeps two
    // generations of one RESUMED session (same id, different lease) from
    // releasing each other's connections. See McpLease in mcp-manager.ts.
    private mcpManager?: { destroyAll(): Promise<void>; acquire(sessionId: string): Promise<McpLease> },
  ) {
    super();
    // Re-emit broker asks/expirations so ipc-handlers can forward them to the
    // renderer + remote clients (see the 'hook-event' listener there).
    this.broker.on('hook-event', (event) => this.emit('hook-event', event));
  }

  /** Route a renderer/remote permission response to the broker. Returns false
   *  when the id isn't a pending native ask so ipc-handlers falls through to
   *  hookRelay (CC asks share the permission:respond channel). */
  respondPermission(requestId: string, decision: Record<string, unknown>): boolean {
    return this.broker.respond(requestId, decision);
  }

  /** Raise a native permission ask (Task 12's decide() will call this). Resolves
   *  when the user responds or the session is interrupted (→ 'canceled'). */
  askPermission(req: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    denyListed: boolean;
  }): Promise<AskDecision> {
    return this.broker.ask(req);
  }

  /** Wire the "no session uses model X anymore" callback (→ engine unload). */
  setModelReleasedHandler(fn: (modelId: string) => void): void {
    this.onModelReleased = fn;
  }

  private retainModel(sessionId: string, modelId: string): void {
    let set = this.modelRefs.get(modelId);
    if (!set) { set = new Set(); this.modelRefs.set(modelId, set); }
    set.add(sessionId);
  }

  private releaseModel(sessionId: string, modelId: string): void {
    const set = this.modelRefs.get(modelId);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) {
      this.modelRefs.delete(modelId);
      try { this.onModelReleased?.(modelId); } catch { /* best-effort */ }
    }
  }

  /** Live sessions currently bound to a model (for the state coordinator). */
  sessionsForModel(modelId: string): string[] {
    return [...(this.modelRefs.get(modelId) ?? [])];
  }

  /** The model a live session is bound to right now (null if not live). */
  modelForSession(sessionId: string): string | null {
    return this.live.get(sessionId)?.session.binding.modelId ?? null;
  }

  /** Set a session's permission mode (renderer chip → NATIVE_SET_PERMISSION_MODE).
   *  Validates LOUDLY: an unknown mode string is a renderer/wiring bug, so throw
   *  (rejecting the invoke() promise at the ipcMain.handle boundary) rather than
   *  silently storing garbage. Returns the applied mode as the authoritative
   *  value the chip renders. Pending asks are untouched — decide() re-reads the
   *  mode on the NEXT gated tool, so a flip never disturbs an in-flight ask. */
  setPermissionMode(sessionId: string, mode: NativePermissionMode): NativePermissionMode {
    const VALID: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
    if (!VALID.includes(mode)) {
      throw new Error(`Unknown native permission mode: ${String(mode)} (expected one of ${VALID.join(', ')}).`);
    }
    this.modeFor.set(sessionId, mode);
    return mode;
  }

  /** The per-session permission decision closure passed into each HarnessSession.
   *  Re-reads the session's current mode + remembered rules on EVERY call, so a
   *  mid-session mode flip (setPermissionMode) — and any newly-remembered rule —
   *  takes effect on the NEXT gated tool. */
  private buildDecide(sessionId: string, cwd: string, presetRules: PermissionRule[]) {
    return async (tool: string, subject: string | undefined) => decidePermission(tool, subject, {
      presetRules,                           // preset manifests contribute here — lowest layer, mode/deny/remembered all override
      modeRules: rulesForMode(this.modeFor.get(sessionId) ?? 'ask'),
      denyList: DESTRUCTIVE_DENY_LIST,
      // Union disk (cross-session record) with this session's in-memory rules
      // (session-truth). Disk first, in-memory appended after — a later match
      // wins in the engine, but the two are identical allow rules so the tie is
      // harmless. In-memory is what guarantees an Always-allow sticks even if the
      // async disk persist failed or hasn't landed yet (see rememberedFor above).
      rememberedRules: [
        ...await this.permissionStore.rulesFor(cwd),
        ...(this.rememberedFor.get(sessionId) ?? []),
      ],
    });
  }

  /** Resolve BOTH the clamped context window AND the capability profile for a
   *  binding, together (create/resume/swap all need the pair). The context is the
   *  engine's real loaded window (Task 4) clamped to a known model's trained
   *  ceiling (Task 5's registry clamp); the profile is resolved from the binding's
   *  provider type + model id + that clamped context. An unknown provider type
   *  falls back to 'openrouter' — the cloud-safe default (full posture). */
  private async resolveContextAndProfile(binding: ModelBinding): Promise<{ contextLength: number | null; profile: CapabilityProfile }> {
    const raw = await this.contextLengthFor(binding);
    const type = (await this.providerTypeFor(binding)) ?? 'openrouter';     // unknown → cloud-safe default
    // The registry ceiling (effectiveContextForModel) is a LOCAL-model concern: it
    // caps a small GGUF loaded at a too-large -c to its real trained window. But
    // matchKnownModel keys ONLY on the model-id regex, so a HOSTED model whose id
    // happens to match a local family (e.g. OpenRouter `qwen/qwen3.5-9b` matching
    // the local Qwen entry) would be wrongly clamped, capping a cloud window that
    // may be far larger. So resolve the provider type FIRST and only clamp locals;
    // cloud/hosted bindings pass their real window through unchanged.
    const contextLength = type === 'local-engine' ? effectiveContextForModel(raw, binding.modelId) : raw;
    const profile = resolveProfile({ providerType: type, modelId: binding.modelId, contextLength });
    return { contextLength, profile };
  }

  /** Tool + permission + prompt wiring shared by create() and resume(). Both v1
   *  presets (Assistant, Coder) are personality profiles, not capability tiers
   *  (spec decisions 8/9): EVERY native session carries the full CORE_TOOLS
   *  suite — presets differ only in prompt body (preset.body) and permission
   *  posture (preset.presetRules + the seeded starting mode). The resolved
   *  `profile` is accepted here so Task 6 can add a prompt variant without another
   *  signature change; this task doesn't use it yet (the session itself carries it
   *  via opts.profile). */
  private toolWiring(sessionId: string, cwd: string, preset: ResolvedPreset, profile: CapabilityProfile): Pick<HarnessSessionOpts, 'tools' | 'decide' | 'askUser' | 'systemPrompt' | 'toolServices' | 'skillCatalog' | 'triggers'> {
    return {
      tools: CORE_TOOLS,
      // Project rules + nested project instructions, indexed ONCE per session
      // (M3 item 3). Built here rather than in the session because it is
      // filesystem state scoped to the session's cwd, and re-statting the tree
      // per tool call would be a real cost on a large repo.
      triggers: buildTriggerIndex(cwd),
      // Skill is NOT in CORE_TOOLS — it is attached per session by
      // buildAiTools when the profile can afford its catalog. Threading the
      // catalog (rather than letting the session scan on its own) means the host
      // and the session agree on one source, and a test can inject a fake.
      ...(this.skillCatalog ? { skillCatalog: this.skillCatalog } : {}),
      decide: this.buildDecide(sessionId, cwd, preset.presetRules),
      askUser: (req) => this.broker.ask(req),
      // Thread injected runtime services (WebSearch's SearchService) into the
      // HarnessSession opts — only when present, so a host built without them
      // leaves toolServices undefined (tools handle the absence as a config error).
      ...(this.toolServices ? { toolServices: this.toolServices } : {}),
      // WHY assembleSystemPrompt is called synchronously here: it shells out to
      // git twice (execFileSync, 3s timeout each → ~6s worst case). It runs ONCE
      // per session create/resume — NEVER on the per-turn send() path — so the
      // accepted sync cost sits off the hot loop. Threading an await through here
      // would ripple through every construction site for no per-turn benefit
      // (Task 11 review ruling — the sync cost is deliberate and bounded).
      // profile.promptVariant selects the capability-steering overlay (local-small only in v1).
      // hasTools mirrors buildAiTools()'s gate: a tool-less profile (supportsTools === false)
      // gets NO tools attached, so the prompt must also drop the tool-guidance line + overlay.
      // instructionBudgetTokens reuses the profile's injection budget rather than
      // adding a fifth tunable: the root AGENTS.md/CLAUDE.md is the same KIND of
      // content as the nested instruction files and rules that budget already
      // sizes, so a second ladder would only be a second thing to drift.
      // NOTE this is fixed for the session's life — the system prompt is never
      // reassembled, not even by setBinding's mid-session model swap (that is what
      // keeps the KV-cache prefix stable). Sizing therefore follows the model the
      // session STARTED on. Deliberate; revisit only if prompt reassembly ever is.
      systemPrompt: assembleSystemPrompt({ presetBody: preset.body, cwd, appVersion: this.appVersion, promptVariant: profile.promptVariant, hasTools: profile.supportsTools, instructionBudgetTokens: profile.injectionBudgetTokens }),
    };
  }

  /** Acquire this session's pooled MCP servers (Task 6) — the ONE production
   *  caller of McpManager.acquire(). undefined when no manager is wired (every
   *  existing test construction, which predates Task 6) or when acquisition
   *  itself fails: a registry-wide failure (a corrupt `~/.youcoded/mcp.json`,
   *  a secrets-store read error) must not block the session from opening at
   *  all — MCP is one optional capability layered onto the tool set, not a
   *  precondition for having a session at all. A single broken SERVER is
   *  already handled inside McpManager itself (excluded from the returned
   *  list, never a rejection) — this only guards the rarer whole-registry
   *  failure. */
  private async acquireMcp(sessionId: string): Promise<McpLease | undefined> {
    if (!this.mcpManager) return undefined;
    try {
      return await this.mcpManager.acquire(sessionId);
    } catch (err) {
      log('ERROR', 'NativeSessionHost', 'mcp acquire failed — session opens with no MCP servers', { sessionId, error: String(err) });
      return undefined;
    }
  }

  /** Subscribe a freshly-built HarnessSession: forward its events to the
   *  renderer immediately, and enqueue each on the session's append chain. */
  private wire(sessionId: string, cwd: string, session: HarnessSession, mcpLease?: McpLease): void {
    const entry: LiveEntry = { session, cwd, appendChain: Promise.resolve(), queue: [], inFlight: false, mcpLease };
    this.live.set(sessionId, entry);
    this.retainModel(sessionId, session.binding.modelId); // ref-count this model
    // Persist "Always allow" decisions for THIS session's project. The session
    // emits 'remember-rule' {tool, pattern?, action} — a plain EventEmitter
    // event, NOT a transcript event (the frozen transcript surface is untouched)
    // — whenever the user picks Always-allow. The host owns the cwd → project
    // slug scoping via PermissionStore. Fire-and-forget: a failed persist must
    // not break the turn (the rule is a convenience, re-asked next time).
    session.on('remember-rule', (rule: PermissionRule) => {
      // (1) Record in-memory SYNCHRONOUSLY first, deduping exact repeats — this is
      // what makes the Always-allow stick for the rest of the session regardless
      // of whether the disk write below succeeds or wins the race with the next
      // tool call.
      const mem = this.rememberedFor.get(sessionId) ?? [];
      if (!mem.some((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action)) {
        mem.push(rule);
        this.rememberedFor.set(sessionId, mem);
      }
      // (2) Then persist the cross-session record. Fire-and-forget: a failed
      // persist must not break the turn, and (1) already covers this session.
      void this.permissionStore.remember(cwd, rule).catch((err) => {
        log('ERROR', 'NativeSessionHost', 'remember-rule persist failed', { sessionId, error: String(err) });
      });
    });
    session.on('transcript-event', (event: TranscriptEvent) => {
      // (1) Forward NOW — not gated on the disk write (see module header).
      this.emit('transcript-event', event);
      // (2) Persist on the per-session chain so appends stay serialized.
      entry.appendChain = entry.appendChain
        .then(() => this.store.append(cwd, event))
        .catch((err) => {
          // Swallow so one failed append can't wedge the chain — the next
          // event's append must still run.
          log('ERROR', 'NativeSessionHost', 'append failed', {
            sessionId, type: event.type, error: String(err),
          });
        });
    });
  }

  /** Fresh session: write the header, build + wire a live HarnessSession. */
  async create(opts: CreateNativeSessionOpts): Promise<void> {
    // Same single-writer guard as resume() — create() also ends in wire(), so an
    // id that is somehow still live would gain a second appending listener here
    // too. Cheap and idempotent; closes the class at BOTH wire() entry points
    // rather than only the one we know a caller reached.
    if (this.live.has(opts.sessionId)) {
      log('WARN', 'NativeSessionHost', 'create found a live session under the same id — destroying the orphan first', { sessionId: opts.sessionId });
      await this.destroy(opts.sessionId);
    }
    const preset = resolvePreset(opts.presetId);
    const { contextLength, profile } = await this.resolveContextAndProfile(opts.binding);
    await this.store.create({
      v: 1,
      sessionId: opts.sessionId,
      harnessId: preset.manifest.id,
      binding: opts.binding,
      cwd: opts.cwd,
      createdAt: Date.now(),
    });
    // The preset seeds the STARTING mode; an explicit setPermissionMode always
    // wins — modeFor is never overwritten here (plan decision 3).
    if (!this.modeFor.has(opts.sessionId)) this.modeFor.set(opts.sessionId, preset.defaultMode);
    // Acquire this session's MCP servers (Task 6) BEFORE constructing the
    // session, so mcpServers is available for the very first buildAiTools().
    const mcpLease = await this.acquireMcp(opts.sessionId);
    const mcpServers = mcpLease?.servers;
    let session: HarnessSession;
    try {
      // Fix pass 1 / Finding 3: this whole block is fallible synchronous work
      // (toolWiring() calls assembleSystemPrompt(), buildTriggerIndex()) that
      // runs AFTER the mcp acquire() above but BEFORE wire() ever registers
      // this id in `this.live`. destroy() early-returns for a non-live id, so
      // a throw here — with no catch — would strand the acquired MCP hold
      // (and the pooled server's spawned child process) for the rest of the
      // app's lifetime. Release the hold and rethrow the ORIGINAL error
      // unchanged (never guess/replace a cause — error-message-standards.md).
      session = new HarnessSession(
        { sessionId: opts.sessionId, cwd: opts.cwd, harness: preset.manifest, binding: opts.binding, contextLength, profile,
          ...(mcpServers ? { mcpServers } : {}),
          ...this.toolWiring(opts.sessionId, opts.cwd, preset, profile) },
        this.modelFactory,
      );
    } catch (err) {
      await mcpLease?.release();
      throw err;
    }
    this.presetIdFor.set(opts.sessionId, preset.manifest.id);
    this.wire(opts.sessionId, opts.cwd, session, mcpLease);
  }

  /** Rebuild a live session from its stored header + events. Returns false when
   *  no native session file exists for this id (caller should fall through).
   *  `bindingOverride` (Task 6 — resume-time model selector) wins over the
   *  persisted header binding when present. The stored header is NEVER
   *  rewritten (single-writer invariant, native-home.ts) — like the existing
   *  mid-session setBinding(), this override is in-memory only for the live
   *  session. It MUST be applied here, before returning, rather than via a
   *  post-resume setBinding: ipc-handlers.ts reads modelForSession() for the
   *  eager loadModel() the instant resume() resolves, and a later setBinding
   *  would race that read and load the header's (possibly wrong/absent) model
   *  first. */
  async resume(sessionId: string, cwd: string, bindingOverride?: ModelBinding): Promise<boolean> {
    // SINGLE-WRITER GUARD (2026-07-18): tear down any session already live under
    // this id BEFORE wiring a new one. Without this, resuming an id that is still
    // live leaves the old HarnessSession's transcript-event listener attached —
    // it closes over the OLD `entry`, so wire()'s `this.live.set` overwriting the
    // map entry does NOT stop it appending (see destroy()'s comment below). The
    // result was two writers on one JSONL, unordered against each other, breaking
    // the single-writer invariant at native-home.ts:5-7 that justifies the absence
    // of a file lock. Callers could orphan a session from several paths (takeover,
    // session-exit), so the guard lives HERE, at the one place a second writer can
    // actually be created, rather than in each caller.
    if (this.live.has(sessionId)) {
      log('WARN', 'NativeSessionHost', 'resume found a live session under the same id — destroying the orphan first', { sessionId });
      await this.destroy(sessionId);
    }
    const header = this.store.readHeader(sessionId, cwd);
    if (!header) return false;
    // Read-side legacy mapping: a stored 'chat' header (or any unknown id)
    // resolves to Assistant. The stored header is NEVER rewritten (spec
    // decision 8) — the mapping lives only here + in presetIdFor.
    const preset = resolvePreset(header.harnessId);
    // MERGE RECONCILIATION (Plan C × M2): the capability profile must be resolved
    // for the binding we are ACTUALLY going to run, which is the resume-time
    // override when the user picked a model in the picker — not the one frozen in
    // the header. Profiling header.binding here would size the context window and
    // tool posture for the wrong model on every overridden resume.
    const binding = bindingOverride ?? header.binding;
    const { contextLength, profile } = await this.resolveContextAndProfile(binding);
    // Seed the STARTING mode from the resolved preset unless the caller already
    // set one for this id (an explicit setPermissionMode always wins).
    if (!this.modeFor.has(sessionId)) this.modeFor.set(sessionId, preset.defaultMode);
    // Acquire this session's MCP servers (Task 6). A RESUMED session reuses its
    // old sessionId, so this acquire() can overlap a release() still in flight
    // from a destroy() of the SAME id. That used to be the bug: both
    // generations wrote to one sessionId-keyed holder entry and the outgoing
    // destroy() closed the incoming session's connections. It is now safe
    // structurally — this acquire() mints its own lease, and the outgoing
    // destroy() can only release the lease on the LiveEntry it captured. See
    // McpLease in mcp-manager.ts.
    const mcpLease = await this.acquireMcp(sessionId);
    const mcpServers = mcpLease?.servers;
    let session: HarnessSession;
    try {
      // Fix pass 1 / Finding 3 — same leak as create(): everything in this
      // block (construction, then the history rebuild) is fallible synchronous
      // work that runs after the mcp acquire() above but before wire() ever
      // registers this id in `this.live`. A throw anywhere in here — with no
      // catch — would strand the acquired MCP hold permanently (destroy()
      // early-returns for a non-live id). Release and rethrow the ORIGINAL
      // error unchanged (error-message-standards.md).
      session = new HarnessSession(
        // `binding` (not header.binding) — same override reason as above.
        { sessionId, cwd, harness: preset.manifest, binding, contextLength, profile,
          ...(mcpServers ? { mcpServers } : {}),
          ...this.toolWiring(sessionId, cwd, preset, profile) },
        this.modelFactory,
      );
      // Full history rebuild (spec §2.5): rebuildHistory reconstructs the assistant
      // tool-call + tool-result pairs too (the old eventsToMessages dropped every
      // tool event, so a resumed tool turn lost its tool context). seedHistory
      // already clears readRegistry + todos (the reset-on-resume ruling) — those
      // are runtime state, never persisted.
      session.seedHistory(rebuildHistory(this.store.readEvents(sessionId, cwd)));
    } catch (err) {
      await mcpLease?.release();
      throw err;
    }
    this.presetIdFor.set(sessionId, preset.manifest.id);
    this.wire(sessionId, cwd, session, mcpLease);
    return true;
  }

  isNative(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /** Is this id a native session AT ALL — live now, or persisted from any
   *  earlier run? isNative() only answers for LIVE sessions, which is the wrong
   *  question for the phantom-record gate: a past native session picked from the
   *  Resume Browser is not live, but must still never seed a CC store record. */
  isNativeSessionId(sessionId: string): boolean {
    return this.live.has(sessionId) || this.store.has(sessionId);
  }

  /** Send a user turn. SYNCHRONOUS and NEVER throws — the result says what
   *  happened to the CALL, not the turn: 'sent' means the turn was dispatched
   *  (not that it completed — a later provider/tool failure surfaces as a
   *  session-error transcript event, which the renderer already renders),
   *  'queued' means it was FIFO'd behind the in-flight turn (M1 send queue —
   *  a send during a live turn used to be silently dropped), 'failed' means it
   *  was refused outright (reason says why: unknown session, or the queue is
   *  already at SEND_QUEUE_LIMIT). HarnessSession.send() hard-throws on
   *  re-entrancy (a second send while a turn is in flight) — the host never
   *  calls it re-entrantly (inFlight gates that), so the only remaining throw
   *  surface is a provider-factory rejection, which runTurns catches. */
  send(sessionId: string, text: string): NativeSendResult {
    const entry = this.live.get(sessionId);
    if (!entry) return { status: 'failed', reason: 'not-live' };
    if (entry.inFlight) {
      if (entry.queue.length >= SEND_QUEUE_LIMIT) return { status: 'failed', reason: 'queue-full' };
      // Task 11: mint a stable id per queued entry so the renderer can target
      // this exact message later with removeQueued() (Cancel/Edit before send).
      const queueId = randomUUID();
      entry.queue.push({ id: queueId, text });
      return { status: 'queued', queueId };
    }
    entry.inFlight = true;
    // WHY: defer the turn dispatch one macrotask so the invoke reply (the renderer's
    // 'sent' ack) is flushed BEFORE HarnessSession emits the user-message transcript
    // event — otherwise the transcript confirm can beat the ack to the renderer and
    // duplicate the bubble (final-review finding, 2026-07-22). inFlight is set
    // synchronously above, so queueing semantics are unchanged. Edge: an interrupt
    // arriving inside this one-tick gap no-ops (abort doesn't exist yet) and the
    // turn still starts — same outcome as stopping a millisecond before sending.
    // Capture an awaitable handle on this turn's whole drain (current turn +
    // queued follow-ups) so quiesce()/teardown can await it settling. The
    // setImmediate defer is unchanged (see the WHY above); runTurns try/catches
    // its send() so this promise never rejects — .then(resolve, resolve) is
    // belt-and-suspenders against a future throw path.
    entry.running = new Promise<void>((resolve) => {
      setImmediate(() => { void this.runTurns(sessionId, entry, text).then(resolve, resolve); });
    });
    return { status: 'sent' };
  }

  /** Cancel/edit a queued-but-not-yet-sent message (Task 11). Sync findIndex +
   *  splice — the check-and-remove is atomic against the single-threaded drain
   *  loop, which only ever consumes the FRONT of `queue` via shift() (see
   *  runTurns): once splice() has run here, that entry can never be shifted
   *  out and sent, no matter how send()/runTurns interleave around it. Never
   *  throws; returns false (not true+error) for every "can't do that" case —
   *  the session isn't live, the id was never queued, or the drain already
   *  shift()'d it out (a real race the caller must handle, not a bug) — so the
   *  renderer's Cancel/Edit affordance can render a single "too late" toast
   *  without needing to distinguish the reason. */
  removeQueued(sessionId: string, queueId: string): boolean {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    const idx = entry.queue.findIndex((q) => q.id === queueId);
    if (idx === -1) return false;
    entry.queue.splice(idx, 1);
    return true;
  }

  // Runs the dispatched turn, then drains the queue turn-by-turn. send() settling
  // is the ONLY drain trigger — it settles strictly after turn-complete /
  // session-error / user-interrupt, and stays unsettled across a permission ask
  // (an ask pauses the turn; draining on it would hard-throw re-entrancy).
  /** `first` is a plain string for an ordinary send, or a THUNK when the turn
   *  starts some other way — today only /skill-name, whose opener is
   *  `session.runSkill` (same turn machinery, different transcript event).
   *  Queued follow-ups are always plain sends, so queue semantics are unchanged. */
  private async runTurns(sessionId: string, entry: LiveEntry, first: string | (() => Promise<void>)): Promise<void> {
    let next: string | (() => Promise<void>) | undefined = first;
    while (next !== undefined) {
      try {
        if (typeof next === 'function') await next();
        else await entry.session.send(next);
      } catch (err) {
        log('ERROR', 'NativeSessionHost', 'send failed', { sessionId, error: String(err) });
      }
      // Destroy() may have removed/replaced the entry mid-turn — stop draining then.
      if (this.live.get(sessionId) !== entry) return;
      // .text: queue entries are {id, text} (Task 11) — the id only matters to
      // removeQueued(); shift() here is what makes a removed entry unreachable.
      next = entry.queue.shift()?.text;
    }
    entry.inFlight = false;
  }

  /** User-initiated /compact for a native session (M3 item 2). Returns a coded
   *  result rather than a bare boolean so the renderer can say WHY nothing
   *  happened — this path exists specifically to replace a silent no-op.
   *
   *  Refuses while a turn is in flight (including one still draining the M1
   *  queue): compaction rewrites `history`, and doing that underneath a running
   *  turn would corrupt the tool-call/result pairing the whole driver depends on.
   *  The session's own re-entrancy guard is the backstop, but refusing here means
   *  the user gets a real explanation instead of a thrown error. */
  async compact(sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const entry = this.live.get(sessionId);
    if (!entry) return { ok: false, reason: 'not-live' };
    if (entry.inFlight || entry.queue.length > 0) return { ok: false, reason: 'turn-in-flight' };
    return entry.session.compactNow();
  }

  /** User-initiated /clear for a native session (M3 item 2) — a context BARRIER,
   *  not a deletion. Same refusal discipline as compact(): a clear that landed
   *  mid-turn would drop the history the running turn is still appending to. */
  clear(sessionId: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.live.get(sessionId);
    if (!entry) return { ok: false, reason: 'not-live' };
    if (entry.inFlight || entry.queue.length > 0) return { ok: false, reason: 'turn-in-flight' };
    return entry.session.clearHistory();
  }

  /** User-initiated /skill-name for a native session (M3 item 1).
   *
   *  The path that works on EVERY model: the Skill TOOL is withheld from small
   *  windows because its catalog would ride every turn, but one explicit
   *  invocation costs a single injection and is affordable anywhere.
   *
   *  Sends the skill's body as an ordinary turn, so it persists to the session
   *  JSONL through the normal `send` path — no new event type, and a resume
   *  replays it like any other message (Global Constraint 2).
   *
   *  Bounded by the profile's injection budget: a long SKILL.md on a small model
   *  would otherwise crowd out the conversation it is meant to act on. */
  async invokeSkill(sessionId: string, skill: string, args?: string): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
    const entry = this.live.get(sessionId);
    if (!entry) return { ok: false, reason: 'not-live' };
    // Same refusal discipline as compact/clear: queueing this would land the
    // instructions after work that was started without them.
    if (entry.inFlight || entry.queue.length > 0) return { ok: false, reason: 'turn-in-flight' };

    let loaded;
    try {
      loaded = (this.skillCatalog ?? createSkillCatalog()).load(skill);
    } catch (err: any) {
      // SkillNotFound is the ordinary case — the user typed a Claude Code command
      // or a skill they haven't installed — so it is a coded refusal, not an error.
      const reason = err?.name === 'SkillNotFound' ? 'not-a-skill'
        : err?.name === 'SkillUnreadable' ? 'unreadable'
        : err?.name === 'SkillAmbiguous' ? 'ambiguous'
        : 'error';
      return { ok: false, reason, detail: err?.message ?? String(err) };
    }

    const fitted = fitInjection(loaded.body, entry.session.profileSnapshot.injectionBudgetTokens);
    // runSkill, NOT send: the model needs the instructions but the TIMELINE needs
    // to show what the user did. Sending the body through send() rendered a 26k
    // character SKILL.md as a chat bubble (Destin, 2026-07-28).
    // frameSkillInvocation owns the wording, which IS the mechanism here — see
    // its header. It also places the user's own args last.
    const body = frameSkillInvocation(loaded.id, fitted.text, args);

    entry.inFlight = true;
    // Same setImmediate defer as send(): the IPC reply must flush BEFORE the
    // session emits its transcript event, or the confirm can beat the ack to the
    // renderer. runTurns owns inFlight teardown and queue draining from here.
    setImmediate(() => {
      void this.runTurns(sessionId, entry, () => entry.session.runSkill({
        skillId: loaded.id,
        displayName: loaded.displayName,
        body,
        // NOT passed to runSkill: frameSkillInvocation already placed them last
        // inside `body`. Passing them here too would repeat the user's words.
        skillPath: loaded.file,
      }));
    });
    return { ok: true };
  }

  interrupt(sessionId: string): boolean {
    const entry = this.live.get(sessionId);
    // Cancel pending asks FIRST (resolve them 'canceled') so a loop paused on a
    // permission await unwinds cleanly before the stream is aborted underneath
    // it (spec pending-ask ruling). Also expires the renderer's approval cards.
    this.broker.cancelSession(sessionId);
    entry?.session.interrupt();
    return !!entry;
  }

  /** Takeover/teardown quiesce (Task 9). STRONGER than interrupt() and ONLY for
   *  takeover/teardown — never the user-facing Stop button (that's interrupt()).
   *
   *  WHY stronger: interrupt() aborts only the CURRENT turn and lets the M1 FIFO
   *  queue keep draining (pinned by native-session-host.test.ts "interrupt aborts
   *  the current turn only"). For a takeover that is WRONG — a queued message
   *  would start a NEW turn AFTER the flush and append PAST it, corrupting the
   *  transcript the requester is about to pull. quiesce guarantees the opposite:
   *  after it resolves, NO further appends happen for this session until a new send.
   *
   *  Order is load-bearing:
   *   1. Clear the queue SYNCHRONOUSLY so no queued message can start a post-flush
   *      turn. The queue-remove surface (removeQueued) tracks no promises — a
   *      queued send returned 'queued' synchronously with nothing awaiting it — so
   *      dropping the array IS the whole cancel; there is nothing to resolve/refuse.
   *   2. Await one macrotask so a send() issued in the SAME tick as this quiesce
   *      has run its setImmediate dispatch (send() defers runTurns one macrotask —
   *      see send()). Interrupting before that dispatch would MISS the turn: the
   *      AbortController doesn't exist until runTurns actually starts it.
   *   3. cancelSession (resolve a paused permission ask 'canceled', expire its
   *      card) + session.interrupt() (abort the in-flight stream) — same pair as
   *      interrupt(), so a loop paused on an ask unwinds before the stream aborts.
   *   4. Await the in-flight turn chain settling (entry.running): runTurns exits
   *      after the interrupted turn emits user-interrupt and the (now-empty) queue
   *      drains. This is the step interrupt() does NOT do — it is what makes the
   *      "no appends after quiesce" invariant hold.
   *   5. Await the append chain (drain) so every already-enqueued append lands on
   *      disk before the caller flushes the transcript to the space. */
  async quiesce(sessionId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    entry.queue.length = 0;                        // (1) no post-flush turn can start
    await new Promise((r) => setImmediate(r));      // (2) let a same-tick send dispatch
    this.broker.cancelSession(sessionId);           // (3) unwind a paused permission ask
    entry.session.interrupt();                      //     abort the in-flight turn
    try { await entry.running; } catch { /* runTurns never rejects; belt-and-suspenders */ } // (4)
    await this.drain(sessionId);                    // (5) flush already-enqueued appends
  }

  /** Mid-session model swap (next turn uses the new binding). */
  async setBinding(sessionId: string, binding: ModelBinding): Promise<boolean> {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    const oldModelId = entry.session.binding.modelId;
    // Re-resolve BOTH context + profile on a swap: a cloud → small-local swap
    // (or vice versa) crosses capability tiers, so the driver must pick up the
    // new doom-loop window / tool posture on the next turn.
    const { contextLength, profile } = await this.resolveContextAndProfile(binding);
    entry.session.setBinding(binding, contextLength, profile);
    if (oldModelId !== binding.modelId) {
      // Swap the ref-count: releasing the old model may unload it if this was
      // its last session (#1); retain the new one so it isn't unloaded.
      this.retainModel(sessionId, binding.modelId);
      this.releaseModel(sessionId, oldModelId);
    }
    return true;
  }

  getBinding(sessionId: string): ModelBinding | null {
    return this.live.get(sessionId)?.session.binding ?? null;
  }

  /** Replay source for a native session. null for unknown/non-native ids so
   *  the caller (TRANSCRIPT_REPLAY) falls through to the CC transcript watcher. */
  getHistory(sessionId: string): TranscriptEvent[] | null {
    const entry = this.live.get(sessionId);
    if (!entry) return null;
    return this.store.readEvents(sessionId, entry.cwd);
  }

  /** Await this session's pending appends — a real "flush the queue" affordance
   *  and the test hook that makes disk state deterministic after send(). */
  async drain(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.appendChain;
  }

  /** Resume Browser rows — every persisted native session, tagged 'native'. */
  list(): (NativeSessionListEntry & { provider: 'native' })[] {
    return this.store.list().map((r) => ({ ...r, provider: 'native' as const }));
  }

  /** Graceful teardown of one session. No-op for unknown ids (so the
   *  SESSION_DESTROY handler can call it for every session id blindly).
   *
   *  Order matters — STOP THE SOURCE FIRST:
   *   1. session.destroy() aborts the in-flight stream AND removeAllListeners()
   *      — removing our transcript-event listener is what actually stops new
   *      appends being enqueued (the listener closes over `entry`, so deleting
   *      the map entry alone would NOT stop re-enqueue mid-stream).
   *   2. await the appendChain — drain appends already enqueued before step 1.
   *   3. store.dispose() — flush the buffered open streaming part.
   *   4. drop the map entry. */
  async destroy(sessionId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    // Resolve any pending asks for this session ('canceled') + expire their
    // cards BEFORE tearing down the stream — same rationale as interrupt(); a
    // loop paused on a permission await must unwind, and the promise must not
    // leak past teardown.
    this.broker.cancelSession(sessionId);
    const modelId = entry.session.binding.modelId; // capture before teardown
    entry.session.destroy();             // abort stream + remove our listener → no new appends
    await entry.appendChain;             // drain already-enqueued appends
    await this.store.dispose(sessionId); // flush the buffered open part
    this.live.delete(sessionId);
    // Drop per-session runtime state so it can't leak and so a destroy→resume of
    // the SAME sessionId within one app run starts clean: mode resets to the
    // default 'ask', and the in-memory remembered rules fall back to the disk
    // record (never carried across a teardown).
    this.modeFor.delete(sessionId);
    this.rememberedFor.delete(sessionId);
    this.presetIdFor.delete(sessionId);
    this.releaseModel(sessionId, modelId); // last session gone → unload it (#1)
    // Release THIS generation's MCP lease (Task 6), LAST — orthogonal to the
    // transcript/live-map teardown above (releasing never touches either), so
    // ordering it after doesn't affect that invariant. `entry` was captured at
    // the top of this method, before any await, so a resume() for this same
    // sessionId racing us installs its own LiveEntry with its own lease and
    // this call cannot reach it. No-ops harmlessly when this session never
    // acquired anything (no manager wired, or acquireMcp caught a failure).
    await entry.mcpLease?.release();
  }

  /** App-shutdown path: destroy every live session, then flush any residue. */
  async destroyAll(): Promise<void> {
    // Cancel every pending ask up front (covers asks whose session is no longer
    // live, which the per-session destroy loop below would miss).
    this.broker.cancelAll();
    for (const id of [...this.live.keys()]) {
      await this.destroy(id);
    }
    await this.store.flushAll();
    // Tear down every pooled MCP server connection HERE too. Without this, an
    // MCP server's spawned subprocess (e.g. a stdio server) would outlive the
    // app instead of being closed alongside it.
    //
    // SCOPE OF THAT PROMISE, precisely: this runs via ipc-handlers.ts cleanup(),
    // which main.ts calls from its shutdownApp() teardown. As of 2026-08-05 that
    // teardown is reached from all three quit routes — window-all-closed,
    // before-quit (macOS Cmd+Q, dock quit, menu quit), and a SIGTERM/SIGINT from
    // an OS shutdown or logout — so this line can now be read as "covered at
    // every quit." Before that fix, window-all-closed was the app's only
    // quit-related listener and every other route leaked the subprocess.
    // What is still NOT covered, and cannot be: SIGKILL, a power loss, or a
    // main-process crash. Nothing in userland runs on those.
    await this.mcpManager?.destroyAll();
  }
}
