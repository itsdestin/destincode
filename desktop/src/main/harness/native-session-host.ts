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
import type { TranscriptEvent } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import { HarnessSession, type ModelFactory, type HarnessSessionOpts } from './harness-session';
import { rebuildHistory } from './history-rebuild';
import { SessionStore, type NativeSessionListEntry } from './session-store';
import { PermissionBroker, type AskDecision } from './permission-broker';
import { resolvePreset, type ResolvedPreset } from './preset-registry';
import { decidePermission } from './permission-engine';
import { rulesForMode, DESTRUCTIVE_DENY_LIST, type NativePermissionMode, type PermissionRule } from '../../shared/permission-types';
import { assembleSystemPrompt } from './prompt-assembly';
import { CORE_TOOLS } from './tools';
import { log } from '../logger';

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

interface LiveEntry {
  session: HarnessSession;
  cwd: string;
  // Per-session append serialization: each transcript event extends this chain
  // (append(prev).then(next)) so the SessionStore contract (serialized appends)
  // holds. Starts resolved; a failed append is logged but never breaks the
  // chain (a later append must still run).
  appendChain: Promise<void>;
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
    // Remembered "Always allow" rules, scoped per project (Task 12). Defaults to
    // a no-op so the many existing 3-arg test constructions still compile; the
    // real wiring (ipc-handlers) injects a PermissionStore over ~/.youcoded/.
    private permissionStore: RememberedRuleStore = NOOP_REMEMBERED_STORE,
    // Injected because electron's `app` is not importable in tests (mirrors the
    // other injected functions/values above). Feeds the <env> block of the
    // once-per-session assembled system prompt.
    private appVersion: string = '0.0.0-dev',
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

  /** Tool + permission + prompt wiring shared by create() and resume(). Both v1
   *  presets (Assistant, Coder) are personality profiles, not capability tiers
   *  (spec decisions 8/9): EVERY native session carries the full CORE_TOOLS
   *  suite — presets differ only in prompt body (preset.body) and permission
   *  posture (preset.presetRules + the seeded starting mode). */
  private toolWiring(sessionId: string, cwd: string, preset: ResolvedPreset): Pick<HarnessSessionOpts, 'tools' | 'decide' | 'askUser' | 'systemPrompt'> {
    return {
      tools: CORE_TOOLS,
      decide: this.buildDecide(sessionId, cwd, preset.presetRules),
      askUser: (req) => this.broker.ask(req),
      // WHY assembleSystemPrompt is called synchronously here: it shells out to
      // git twice (execFileSync, 3s timeout each → ~6s worst case). It runs ONCE
      // per session create/resume — NEVER on the per-turn send() path — so the
      // accepted sync cost sits off the hot loop. Threading an await through here
      // would ripple through every construction site for no per-turn benefit
      // (Task 11 review ruling — the sync cost is deliberate and bounded).
      systemPrompt: assembleSystemPrompt({ presetBody: preset.body, cwd, appVersion: this.appVersion }),
    };
  }

  /** Subscribe a freshly-built HarnessSession: forward its events to the
   *  renderer immediately, and enqueue each on the session's append chain. */
  private wire(sessionId: string, cwd: string, session: HarnessSession): void {
    const entry: LiveEntry = { session, cwd, appendChain: Promise.resolve() };
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
    const preset = resolvePreset(opts.presetId);
    const contextLength = await this.contextLengthFor(opts.binding);
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
    const session = new HarnessSession(
      { sessionId: opts.sessionId, cwd: opts.cwd, harness: preset.manifest, binding: opts.binding, contextLength,
        ...this.toolWiring(opts.sessionId, opts.cwd, preset) },
      this.modelFactory,
    );
    this.presetIdFor.set(opts.sessionId, preset.manifest.id);
    this.wire(opts.sessionId, opts.cwd, session);
  }

  /** Rebuild a live session from its stored header + events. Returns false when
   *  no native session file exists for this id (caller should fall through). */
  async resume(sessionId: string, cwd: string): Promise<boolean> {
    const header = this.store.readHeader(sessionId, cwd);
    if (!header) return false;
    // Read-side legacy mapping: a stored 'chat' header (or any unknown id)
    // resolves to Assistant. The stored header is NEVER rewritten (spec
    // decision 8) — the mapping lives only here + in presetIdFor.
    const preset = resolvePreset(header.harnessId);
    const contextLength = await this.contextLengthFor(header.binding);
    // Seed the STARTING mode from the resolved preset unless the caller already
    // set one for this id (an explicit setPermissionMode always wins).
    if (!this.modeFor.has(sessionId)) this.modeFor.set(sessionId, preset.defaultMode);
    const session = new HarnessSession(
      { sessionId, cwd, harness: preset.manifest, binding: header.binding, contextLength,
        ...this.toolWiring(sessionId, cwd, preset) },
      this.modelFactory,
    );
    this.presetIdFor.set(sessionId, preset.manifest.id);
    // Full history rebuild (spec §2.5): rebuildHistory reconstructs the assistant
    // tool-call + tool-result pairs too (the old eventsToMessages dropped every
    // tool event, so a resumed tool turn lost its tool context). seedHistory
    // already clears readRegistry + todos (the reset-on-resume ruling) — those
    // are runtime state, never persisted.
    session.seedHistory(rebuildHistory(this.store.readEvents(sessionId, cwd)));
    this.wire(sessionId, cwd, session);
    return true;
  }

  isNative(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /** Send a user turn. false when the session isn't live OR when the turn
   *  couldn't start — this method NEVER throws or rejects. HarnessSession.send()
   *  hard-throws on re-entrancy (a second send while a turn is in flight); the
   *  host swallows that (and any provider-factory throw) here so the
   *  fire-and-forget callers (`void nativeHost.send(...)` in ipc-handlers /
   *  remote-server) can't produce an unhandledRejection — no global handler
   *  exists. The rejected turn's own transcript is unaffected (the first turn
   *  keeps streaming; only the overlapping call is dropped). */
  async send(sessionId: string, text: string): Promise<boolean> {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    try {
      await entry.session.send(text);
      return true;
    } catch (err) {
      log('ERROR', 'NativeSessionHost', 'send failed', { sessionId, error: String(err) });
      return false;
    }
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

  /** Mid-session model swap (next turn uses the new binding). */
  async setBinding(sessionId: string, binding: ModelBinding): Promise<boolean> {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    const oldModelId = entry.session.binding.modelId;
    entry.session.setBinding(binding, await this.contextLengthFor(binding));
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
  }
}
