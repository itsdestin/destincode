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
import type { ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import { HarnessSession, type ModelFactory } from './harness-session';
import { SessionStore, type NativeSessionListEntry } from './session-store';
import { CHAT_PRESET } from '../../shared/harness-manifest';
import { log } from '../logger';

export interface CreateNativeSessionOpts {
  sessionId: string;
  cwd: string;
  binding: ModelBinding;
}

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

  constructor(
    private store: SessionStore,
    private modelFactory: ModelFactory,
    private contextLengthFor: (binding: ModelBinding) => Promise<number | null>,
  ) {
    super();
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

  /** Subscribe a freshly-built HarnessSession: forward its events to the
   *  renderer immediately, and enqueue each on the session's append chain. */
  private wire(sessionId: string, cwd: string, session: HarnessSession): void {
    const entry: LiveEntry = { session, cwd, appendChain: Promise.resolve() };
    this.live.set(sessionId, entry);
    this.retainModel(sessionId, session.binding.modelId); // ref-count this model
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
    const contextLength = await this.contextLengthFor(opts.binding);
    await this.store.create({
      v: 1,
      sessionId: opts.sessionId,
      harnessId: CHAT_PRESET.id,
      binding: opts.binding,
      cwd: opts.cwd,
      createdAt: Date.now(),
    });
    const session = new HarnessSession(
      { sessionId: opts.sessionId, cwd: opts.cwd, harness: CHAT_PRESET, binding: opts.binding, contextLength },
      this.modelFactory,
    );
    this.wire(opts.sessionId, opts.cwd, session);
  }

  /** Rebuild a live session from its stored header + events. Returns false when
   *  no native session file exists for this id (caller should fall through). */
  async resume(sessionId: string, cwd: string): Promise<boolean> {
    const header = this.store.readHeader(sessionId, cwd);
    if (!header) return false;
    const contextLength = await this.contextLengthFor(header.binding);
    const session = new HarnessSession(
      { sessionId, cwd, harness: CHAT_PRESET, binding: header.binding, contextLength },
      this.modelFactory,
    );
    session.seedHistory(this.eventsToMessages(this.store.readEvents(sessionId, cwd)));
    this.wire(sessionId, cwd, session);
    return true;
  }

  /** Stored transcript events → AI SDK message history. User messages map 1:1;
   *  the assistant-text fragments of a turn merge into a SINGLE assistant
   *  message (append to the last pushed message when it's already assistant).
   *  All other event types are ignored (they carry no model-visible content). */
  private eventsToMessages(events: TranscriptEvent[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const e of events) {
      if (e.type === 'user-message' && typeof e.data?.text === 'string') {
        out.push({ role: 'user', content: e.data.text });
      } else if (e.type === 'assistant-text' && typeof e.data?.text === 'string') {
        const last = out[out.length - 1];
        if (last && last.role === 'assistant' && typeof last.content === 'string') {
          last.content += e.data.text;
        } else {
          out.push({ role: 'assistant', content: e.data.text });
        }
      }
    }
    return out;
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
    const modelId = entry.session.binding.modelId; // capture before teardown
    entry.session.destroy();             // abort stream + remove our listener → no new appends
    await entry.appendChain;             // drain already-enqueued appends
    await this.store.dispose(sessionId); // flush the buffered open part
    this.live.delete(sessionId);
    this.releaseModel(sessionId, modelId); // last session gone → unload it (#1)
  }

  /** App-shutdown path: destroy every live session, then flush any residue. */
  async destroyAll(): Promise<void> {
    for (const id of [...this.live.keys()]) {
      await this.destroy(id);
    }
    await this.store.flushAll();
  }
}
