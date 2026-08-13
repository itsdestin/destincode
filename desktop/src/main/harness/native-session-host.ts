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
import { readImageFromDisk } from './image-support';
import { SessionStore, type NativeSessionListEntry } from './session-store';
import { PermissionBroker, type AskDecision } from './permission-broker';
import { resolvePreset, type ResolvedPreset } from './preset-registry';
import { decidePermission } from './permission-engine';
import { rulesForMode, DESTRUCTIVE_DENY_LIST, type NativePermissionMode, type PermissionRule } from '../../shared/permission-types';
import { assembleSystemPrompt } from './prompt-assembly';
import { resolveProfile, effectiveContextForModel, type CapabilityProfile, type ProfileProviderType } from './capability-profile';
import { CORE_TOOLS } from './tools';
import type { ToolServices, SpecialistReservation } from './tools/types';
import { createSkillCatalog, SkillNotFound, type SkillCatalog } from './skills/skill-catalog';
import { canonicalize, resolveP } from './tools/guards';
import { isUnderRoot } from '../artifacts/read-binary-access';
import type { SpecialistDefinition } from './specialists/registry';
import { buildChildDecide } from './specialists/child-permissions';
import { childAskPolicy } from './specialists/child-ask-policy';
import { assignSpecialistName } from './specialists/names';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS, SPECIALIST_SPAWN_BUDGET_PER_SESSION, SPECIALIST_IDLE_STALE_MS, SPECIALIST_IN_TOOL_STALE_MS } from './specialists/limits';
import { DelegationLedger, OWNER } from './specialists/delegation-ledger';
import type { NativeHome } from '../native-home';
import { computeReportBudget } from './specialists/report-budget';
import { truncateOutput, composeNotice } from './tools/truncate';
import { APPROX_CHARS_PER_TOKEN } from './message-size';
import { fitInjection } from './injection/injection-budget';
import { frameSkillInvocation } from './skills/skill-invocation';
import { buildTriggerIndex } from './injection/path-triggers';
import { log } from '../logger';
// Same import PermissionStore uses, for the same reason: the project slug MUST
// come from ONE function everywhere, or the host and the store would disagree
// about which live sessions a stored entry belongs to.
import { cwdToProjectSlug } from '../transcript-watcher';
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
  // Removal keys by project SLUG, not cwd: the slug is what is actually on disk,
  // and cwdToProjectSlug is lossy (see revokeRule), so an entry written before
  // the management UI existed has no recoverable cwd to pass. Both return
  // whether anything actually matched, so the caller can tell the user their
  // on-screen list was stale instead of claiming a success that never happened.
  remove(slug: string, rule: PermissionRule): Promise<boolean>;
  removeProject(slug: string): Promise<boolean>;
}
const NOOP_REMEMBERED_STORE: RememberedRuleStore = {
  async rulesFor() { return []; },
  async remember() { /* no-op */ },
  async remove() { return false; },
  async removeProject() { return false; },
};

// M1 send queue: bounded per program §2.1 — past this many FIFO'd sends, send()
// refuses honestly (status 'failed', reason 'queue-full') instead of accepting
// input the user has no way to know is piling up unseen.
/** One unit of work for the turn drain: the message text plus any composer
 *  attachments that must ride with it. */
type SendUnit = { text: string; attachments: string[] };

const SEND_QUEUE_LIMIT = 10;

// Specialists (Task 7) — the ONLY child transcript event types that are
// re-emitted as stamped DISPLAY copies under the parent's session id.
//
// WHY exactly these three and nothing else: they are precisely what the
// renderer's applySubagentEvent consumes (chat-reducer.ts) to fill the subagent
// card's segments. Every OTHER type is persisted to the child's own file and
// stops there, because a display copy is an event that LOOKS like the parent's
// own — a stamped `turn-complete` would reach the conversation-record IPC
// listener (noteModelUsed) and the conversation-title feeder under the PARENT's
// id, ending the parent's turn in the reducer and attributing the child's model
// usage to the parent. A stamped `session-error` would render the parent's
// session as failed when only the child failed. `user-message` would put the
// child's brief in the parent's timeline as if the user had typed it.
const SUBAGENT_DISPLAY_TYPES = new Set<TranscriptEvent['type']>(['tool-use', 'tool-result', 'assistant-text']);

// The ONE reminder a silent specialist gets before its run is called a failure
// (retry budget 1, spec §3). Deliberately a single short sentence: it is sent
// as an ordinary user turn, so anything longer competes with the brief for the
// child's attention.
const EMPTY_REPORT_NUDGE = 'Your final message is your report — reply with your findings now.';

// Task 1 (plan 1b) — the placeholder value activeWriterChild holds for a
// writer reservation between reserveSpecialist() (which must set the lock
// SYNCHRONOUSLY, before the real child exists) and bindReservation() (which
// swaps it for the real childId once createChild mints one, a few awaits
// later in spawnSpecialist). Never a valid session id, so it can't collide.
const RESERVED_WRITER = '__reserved__';

// Task 7: poll cadence for the staleness check in runSpecialist. Deliberately
// much finer than either threshold (SPECIALIST_IDLE_STALE_MS/
// SPECIALIST_IN_TOOL_STALE_MS, 120s/300s) so a crossing is caught within
// seconds, not up to a whole threshold late. Not exported: nothing outside
// runSpecialist needs to know how often this checks, only what it checks.
const STALE_CHECK_INTERVAL_MS = 5_000;

/** What one specialist run produced. `usage` is summed across the run's turns
 *  (the brief turn plus a nudge turn, if one was needed). */
export interface SpecialistRunResult {
  report: string;
  /** Tool calls the child made, plus its final answering step. The transcript
   *  has no per-step event, so this is counted from `tool-use` events rather
   *  than read off the driver — good enough for a progress/telemetry number,
   *  and it over-counts a step that emitted parallel tool calls. */
  steps: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
}

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
  // `attachments` are absolute composer file paths; image ones become image
  // parts on the user message. Carried through the QUEUE too, or a message sent
  // while a turn was in flight would silently lose its pictures.
  queue: { id: string; text: string; attachments: string[] }[];
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
  // Specialists (plan 1a): set ONLY on a child minted by createChild. It is the
  // back-pointer that lets destroy() de-register this child from its parent's
  // childrenOf set without re-reading the header off disk (see childrenOf).
  parentSessionId?: string;
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

  // Specialists (plan 1a): parent session id → its live specialist children.
  // Maintained by createChild() and by destroy() (which de-registers a child as
  // it tears it down). WHY a map rather than re-reading headers at teardown:
  // destroy()/interrupt()/quiesce() must find a session's children WITHOUT disk
  // I/O — interrupt() is synchronous and cannot read files at all, and a
  // teardown that depended on a readable header would silently leak a running
  // child if the read failed.
  private childrenOf = new Map<string, Set<string>>();

  // Task 8 — the naming easter egg's per-parent draw-without-replacement
  // state: parent session id → first names already handed out to ITS
  // children. Scoped per parent (not global) for the same reason childrenOf
  // is: an unrelated conversation's specialists must not shrink this one's
  // name pool. Cleared alongside childrenOf in destroyChildrenOf() — a fresh
  // delegation under a torn-down-and-reused parent id (there isn't one in
  // practice, but nothing should assume it) would otherwise start with a
  // phantom set of "already used" names.
  private takenNamesOf = new Map<string, Set<string>>();

  // Task 6 — the Task tool's per-parent state (spec §5 Global Constraints
  // scope decision: PER-PARENT, never host-global — one session's specialist
  // fan-out must not be capped, or blocked, by an UNRELATED session's
  // children). Both are keyed by PARENT session id, never by child id.
  //   specialistSlots: how many children this parent currently has running,
  //     against maxSpecialistsFor(parentId) (Task 13: profile-derived — see
  //     capability-profile.ts's maxConcurrentSpecialists; HOSTED_MAX_CONCURRENT_SPECIALISTS,
  //     specialists/limits.ts, remains the value for a hosted profile AND the
  //     defensive fallback below when no live profile is available).
  //   activeWriterChild: the single write-capable (charter: 'read-write')
  //     child currently running under this parent, if any — the single-writer
  //     invariant (two concurrent write-capable children could race edits to
  //     the same files). Absent = no writer active.
  private specialistSlots = new Map<string, number>();
  private activeWriterChild = new Map<string, string>();
  // Task 12, item 3: per-parent LIFETIME spawn count against
  // SPECIALIST_SPAWN_BUDGET_PER_SESSION — never decremented (unlike
  // specialistSlots above), because it is a runaway-loop backstop, not a
  // concurrency gate. In-memory only: a fresh conversation gets a fresh budget.
  private specialistSpawnCounts = new Map<string, number>();

  // Task 2 (plan 1b) — the durable delegation-ledger sidecar
  // (delegation-ledger.ts). undefined whenever no NativeHome was injected
  // (most existing test constructions, which have no reason to touch disk for
  // this) — every call site below guards on `this.ledger` and no-ops in that
  // case, so recording is best-effort in tests but MANDATORY in production
  // (ipc-handlers.ts always injects the shared nativeHome).
  private ledger?: DelegationLedger;

  /** Task 13 — the parent's own resolved CapabilityProfile now carries its
   *  concurrency ceiling (maxConcurrentSpecialists): the spec's flat hosted
   *  constant for a cloud/hosted session, an engine-measured (clamped 1-4)
   *  number for a known local model, 1 for an unrecognized one — see
   *  capability-profile.ts. Falls back to HOSTED_MAX_CONCURRENT_SPECIALISTS
   *  only when the parent isn't live to ask (reserveSpecialist is only ever
   *  called against a live parent in production, so this branch shouldn't be
   *  reachable there — but a missing snapshot must degrade to the
   *  conservative hosted number, never silently allow unbounded fan-out). */
  private maxSpecialistsFor(parentId: string): number {
    return this.live.get(parentId)?.session.profileSnapshot.maxConcurrentSpecialists
      ?? HOSTED_MAX_CONCURRENT_SPECIALISTS;
  }

  // WHY: 1a checked writer-busy in task.ts and set the lock after an await in
  // spawnSpecialist — a check-then-set race the 1a comment explicitly deferred to
  // this plan. Reserve slot AND writer in one synchronous step; the token is the
  // only way to release, so a throw between reserve and spawn can't leak either.
  reserveSpecialist(parentId: string, opts: { writer: boolean }):
    { ok: true; token: SpecialistReservation }
    | { ok: false; reason: 'at-capacity'; max: number }
    | { ok: false; reason: 'writer-busy' } {
    if (opts.writer && this.activeWriterChild.has(parentId)) return { ok: false, reason: 'writer-busy' };
    const current = this.specialistSlots.get(parentId) ?? 0;
    const max = this.maxSpecialistsFor(parentId);
    // Task 13: carry the RESOLVED ceiling on the refusal itself — tools/task.ts
    // renders `max` straight into the at-capacity message, so a local
    // session's real (possibly smaller) ceiling is what the model reads,
    // never a hardcoded hosted constant that doesn't match what was enforced.
    if (current >= max) return { ok: false, reason: 'at-capacity', max };
    this.specialistSlots.set(parentId, current + 1);
    const token: SpecialistReservation = { parentId, writer: opts.writer };
    if (opts.writer) this.activeWriterChild.set(parentId, RESERVED_WRITER); // placeholder until a childId binds
    return { ok: true, token };
  }

  /** Swap the RESERVED_WRITER placeholder for the real childId once
   *  createChild mints one (spawnSpecialist calls this right after createChild
   *  resolves, before the run starts) — a no-op for a reader reservation,
   *  which never touched activeWriterChild. Mutates `token.childId` too, so
   *  releaseReservation's owner check below can tell whether it's clearing
   *  THIS reservation's entry or a later one under the same parent. */
  bindReservation(token: SpecialistReservation, childId: string): void {
    token.childId = childId;
    if (token.writer && this.activeWriterChild.get(token.parentId) === RESERVED_WRITER) {
      this.activeWriterChild.set(token.parentId, childId);
    }
  }

  /** Release a reservation made by reserveSpecialist. Decrements the slot
   *  (deleting the map entry at zero, same as 1a's releaseSpecialistSlot, so a
   *  parent that never delegates again doesn't linger in the map) and, for a
   *  writer reservation, clears the writer lock — but ONLY if it still points
   *  at THIS token's identity (the bound childId, or the RESERVED_WRITER
   *  placeholder if release() runs before bindReservation ever did, e.g. a
   *  spawn that threw before createChild resolved). Fix 5's owner-check (1a
   *  review) carried forward: an unconditional delete would clear whichever
   *  child currently holds parentId's writer lock, including one a LATER
   *  parallel Task call under the same parent reserved after this one. */
  releaseReservation(token: SpecialistReservation): void {
    const current = this.specialistSlots.get(token.parentId) ?? 0;
    if (current <= 1) this.specialistSlots.delete(token.parentId);
    else this.specialistSlots.set(token.parentId, current - 1);
    if (token.writer) {
      const holder = token.childId ?? RESERVED_WRITER;
      if (this.activeWriterChild.get(token.parentId) === holder) this.activeWriterChild.delete(token.parentId);
    }
  }

  /** Spend one unit of this parent's lifetime specialist-spawn budget (Task
   *  12, item 3). false = budget exhausted; the caller (tools/task.ts) must
   *  not spawn. Never released — a runaway-loop backstop, not a resource
   *  limit that frees up as children finish (see specialistSlots for that). */
  trySpendSpecialistSpawnBudget(parentId: string): boolean {
    const used = this.specialistSpawnCounts.get(parentId) ?? 0;
    if (used >= SPECIALIST_SPAWN_BUDGET_PER_SESSION) return false;
    this.specialistSpawnCounts.set(parentId, used + 1);
    return true;
  }

  /** Mint a specialist child, run it to completion, and return its report
   *  (Task 6's gate + bookkeeping, Task 7's run loop).
   *
   *  The whole foreground delegation flow lives here: createChild mints the
   *  cold-started child (Task 5), runSpecialist delivers `opts.prompt` as its
   *  first user turn and returns its last message, and this method wraps that
   *  message with a header + transcript pointer after capping it against the
   *  parent's remaining headroom. The Task tool (tools/task.ts) is what the
   *  MODEL calls; it has already resolved the specialist and reserved the slot
   *  (Task 1, plan 1b: via reserveSpecialist — this method BINDS that
   *  reservation to the real childId once one exists, it does not make one)
   *  before reaching here, and it renders a throw from this method as an
   *  `isError` tool result rather than a dangling call. */
  async spawnSpecialist(parentId: string, opts: {
    specialist: SpecialistDefinition;
    prompt: string;
    workDir: string;
    parentToolCallId: string;
    token: SpecialistReservation;
  }): Promise<{ childId: string; report: string }> {
    const { childId, title } = await this.createChild(parentId, opts);
    // Task 1 (plan 1b): the writer lock (if this reservation asked for one)
    // was already SET synchronously by reserveSpecialist, before tools/task.ts
    // ever awaited this call — this just swaps the RESERVED_WRITER placeholder
    // for the real childId now that one exists. Ownership of the RELEASE moved
    // to tools/task.ts's `finally` (services.release(token)); this method no
    // longer sets OR clears the lock itself, only binds it (single owner: the
    // tool reserves, this binds, the tool releases).
    this.bindReservation(opts.token, childId);
    // Task 2 (plan 1b): captured ONCE — every ledger call below (start,
    // completion, failure) must key off the SAME parent cwd, not a live map
    // re-read that a concurrent teardown could already have cleared by the
    // time the catch block runs.
    const parentCwd = this.live.get(parentId)?.cwd;
    // Fix (review round 2, Finding 2): recordStart now runs INSIDE the try
    // block below instead of before it. It used to run between createChild
    // (which mints the live child, its on-disk header, and a retainModel()
    // ref) and the try whose finally is the LEAK GUARD — so a throw from
    // recordStart (mutateJson can throw on lock exhaustion) skipped that
    // finally entirely and leaked the just-minted child. Every path after
    // createChild now routes through the same teardown guard.
    try {
      if (this.ledger && parentCwd) {
        // Stamp the delegation into the durable ledger the moment the child
        // exists (childId + title known). A crash right after this line still
        // leaves a 'running' row a later pass can see — never silently losing
        // track of a delegation that genuinely started.
        await this.ledger.recordStart(parentCwd, parentId, {
          childId,
          parentToolCallId: opts.parentToolCallId,
          agentType: opts.specialist.id,
          title,
          workDir: opts.workDir,
          // No per-call short label (the Task tool's own `description` arg)
          // reaches this method today — threading it through
          // SpecialistSpawnOpts touches tools/task.ts, out of this task's
          // scope. The specialist's own registered one-liner is a real,
          // accurate description rather than a guessed one, so it stands in.
          description: opts.specialist.description,
          background: false, // Task 2 covers the FOREGROUND flow only.
          status: 'running',
          startedAt: Date.now(),
          delivered: false,
          owner: OWNER,
          missedSteers: [],
        });
      }
      // PRODUCE THE REPORT FIRST, tear down after (Task 6 review handoff note
      // 1). Both statements below are pure/local once the run has finished, so
      // by the time the finally block runs the report is already a value this
      // method owns — a teardown failure can no longer discard work the child
      // genuinely produced.
      const run = await this.runSpecialist(childId, opts.prompt);
      const report = this.formatSpecialistReport({ parentId, childId, specialist: opts.specialist, title, body: run.report });
      if (this.ledger && parentCwd) {
        // Fix (review round 2, Finding 1): this write used to sit INSIDE the
        // same try the child run does, with no catch of its own — so a throw
        // here (mutateJson can throw on lock exhaustion) fell into the catch
        // below, which recorded 'failed' and rethrew, discarding a report the
        // child genuinely produced. Foreground delivery IS the tool result
        // returned right below — a bookkeeping failure on the way out must
        // never discard it or relabel the run a failure, so this write is now
        // its own try/catch: log-only, never fatal, never changes what this
        // method returns.
        try {
          await this.ledger.update(parentCwd, parentId, childId, {
            status: 'completed', endedAt: Date.now(), steps: run.steps, rawReport: run.report, delivered: true,
          });
        } catch (ledgerErr) {
          log('ERROR', 'NativeSessionHost', 'failed to record specialist completion in the ledger — the report is still returned to the caller', { childId, parentId, error: String(ledgerErr) });
        }
      }
      return { childId, report };
    } catch (err: any) {
      if (this.ledger && parentCwd) {
        // Fix (review round 2, Finding 4): updateIfRunning (not update) — a
        // teardown-driven 'interrupted' write (destroyChildrenOf) may already
        // have landed on this record by the time this catch runs (the child's
        // abort error is what surfaces here once the interrupt propagates).
        // 'interrupted' names the true cause (a parent teardown); this catch's
        // 'failed' is only that cause's symptom, so it must not clobber a
        // record that already reached a terminal status — see
        // updateIfRunning's own WHY comment for the full ordering argument.
        // Wrapped in its own try/catch for the same reason as the completion
        // write above: a failure HERE must not replace the real error `err`
        // that error-message-standards.md requires this catch to rethrow.
        try {
          await this.ledger.updateIfRunning(parentCwd, parentId, childId, {
            // Specific and accurate (error-message-standards.md): the real
            // thrown message, never a guessed cause.
            status: 'failed', endedAt: Date.now(), failureText: err?.message ?? String(err),
          });
        } catch (ledgerErr) {
          log('ERROR', 'NativeSessionHost', 'failed to record specialist failure in the ledger', { childId, parentId, error: String(ledgerErr) });
        }
      }
      throw err;
    } finally {
      // Fix 1 (review round 1): LEAK GUARD. Without this, a Task call would
      // strand the child createChild() just minted — a live `this.live` entry,
      // its on-disk header, a retainModel() ref (so its model could never fully
      // unload), and its `childrenOf` registration. The child is a one-shot
      // worker: its report is the only thing that outlives it (its transcript
      // stays on disk), so it is torn down on EVERY exit path, success or not.
      //
      // SWALLOW-AND-LOG, never rethrow (handoff note 1): a throw out of a
      // `finally` REPLACES whatever the try block was returning or throwing. So
      // a teardown failure here would either discard a report the child already
      // produced, or bury the real failure reason under a teardown error. Both
      // are strictly worse than a logged teardown error plus the true outcome.
      try {
        await this.destroy(childId);
      } catch (err) {
        log('ERROR', 'NativeSessionHost', 'specialist teardown failed after the run finished', { childId, parentId, error: String(err) });
      }
    }
  }

  /** Drive ONE specialist child to completion and return its last message.
   *
   *  Failure detection is EVENT-based, not promise-based: the child's turn
   *  drain (`entry.running`) never rejects — runTurns try/catches its send()
   *  (see send()) — so awaiting it only tells us the turn SETTLED, never
   *  whether it succeeded. The transcript stream is what says which: a
   *  `session-error` means the provider/stream failed, `user-interrupt` means
   *  the user (or a parent teardown) stopped it, and `turn-complete`'s
   *  stopReason distinguishes a natural finish from the step cap.
   *
   *  Throws (typed, with the child id) on every no-report outcome; the Task
   *  tool renders that as an isError result for the parent model to read. */
  private async runSpecialist(childId: string, prompt: string): Promise<SpecialistRunResult> {
    const entry = this.live.get(childId);
    if (!entry) throw new Error(`the specialist session ${childId} was gone before its work could start.`);

    // Fix (review): parentId and parentCwd used to be passed in as two extra
    // parameters from spawnSpecialist, duplicating data createChild already
    // stamped onto this child's own live entry — a future second call site
    // could pass either out of sync with what's actually on `entry`. Both are
    // derived here instead: parentSessionId is set unconditionally by
    // createChild for every specialist child, and parentCwd is the one-hop
    // lookup spawnSpecialist itself does (this.live.get(parentId)?.cwd) — NOT
    // entry.cwd, which is this CHILD's own workDir, not its parent's.
    const parentId = entry.parentSessionId;
    const parentCwd = parentId ? this.live.get(parentId)?.cwd : undefined;

    // ---- Task 7 (plan 1b, spec §3): heartbeat staleness, flags-never-kills --
    // Liveness is heartbeat-based, not wall-clock: a slow local model doing a
    // long prefill emits text-less `assistant-thinking` heartbeats that count
    // as activity below (session-store.ts drops them from disk, but the
    // emitter still fires), so it is never flagged. `stale` only ever informs
    // the Task 5 status block and the ledger — nothing here aborts,
    // interrupts, or fails the child; the user's interrupt and the model's own
    // `interrupt: true` (Task 6) are the only things that ever end a run.
    let lastActivityAt = Date.now();
    const openTools = new Set<string>();      // toolUseIds with no tool-result yet
    let isStale = false;                      // mirrors the ledger's `stale` field
    const setStale = (next: boolean) => {
      if (isStale === next) return;           // write ONLY on transitions — not every poll tick
      isStale = next;
      if (this.ledger && parentCwd && parentId) {
        // Fire-and-forget, same log-only/never-fatal contract every other
        // ledger write in this method follows: a bookkeeping failure must
        // never disturb a run that is otherwise healthy. updateIfRunning (not
        // update) so a flag can't resurrect/overwrite a record that already
        // reached a terminal status (interrupted/failed/completed) elsewhere.
        // parentId's `&&` check here is belt-and-suspenders for the type
        // checker (entry.parentSessionId is optional on LiveEntry) — createChild
        // always sets it for a specialist child, so this method is only ever
        // reached with both defined.
        this.ledger.updateIfRunning(parentCwd, parentId, childId, { stale: next }).catch((err) => {
          log('ERROR', 'NativeSessionHost', 'failed to record specialist staleness in the ledger', { childId, parentId, error: String(err) });
        });
      }
    };
    const staleCheck = setInterval(() => {
      const threshold = openTools.size > 0 ? SPECIALIST_IN_TOOL_STALE_MS : SPECIALIST_IDLE_STALE_MS;
      if (Date.now() - lastActivityAt >= threshold) setStale(true);
    }, STALE_CHECK_INTERVAL_MS);

    // ---- Observation state, written by the listener below ----
    let errorText: string | null = null;      // a session-error ended a turn
    let interrupted = false;                  // Stop / parent teardown reached the child
    let stopReason: string | undefined;       // the LAST turn's stopReason
    // Assistant text since the last tool-use. Text emitted BEFORE a tool call
    // is narration ("let me check X"), not the report — the report is whatever
    // the child says after its final tool call, so a tool-use resets this.
    let sinceLastTool = '';
    // The most recent non-empty block, kept for the step-cap case: a child cut
    // off mid-plan never gets to write a final message, and its last narration
    // beats returning nothing at all.
    let lastNonEmpty = '';
    let steps = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    // Task 12, item 4 — compaction-finalize: counts SPONTANEOUS auto-compactions
    // (data.autoCompaction, harness-session.ts's maybeCompact) during this run.
    // A small local context window can force more than one across a long
    // delegated task (spec §3: a designed path, not an edge case) — on the
    // SECOND one, tell the child to wrap up rather than let it compact its way
    // through the whole window and still never report. `steered` caps this at
    // once per child even if a third compaction fires later in the same run.
    let autoCompactionCount = 0;
    let steered = false;

    const onEvent = (event: TranscriptEvent) => {
      // Task 7: ANY event is activity — including a text-less
      // assistant-thinking heartbeat, which is exactly what keeps a slow
      // local prefill from ever being flagged stale. Also the transition
      // point that unflags a child that WAS stale: its next event, whatever
      // type, proves it is alive again.
      lastActivityAt = Date.now();
      setStale(false);
      switch (event.type) {
        case 'assistant-text':
          sinceLastTool += String(event.data.text ?? '');
          if (sinceLastTool.trim()) lastNonEmpty = sinceLastTool;
          break;
        case 'tool-use':
          if (event.data.toolUseId) openTools.add(event.data.toolUseId);
          steps += 1;
          sinceLastTool = '';
          break;
        case 'tool-result':
          // Task 7: closes the window the in-tool (longer) threshold covers —
          // once every open call has its result, silence reverts to the
          // shorter idle threshold. Everything else about this event type
          // (persisting the result) is handled elsewhere; the listener only
          // cares about the tool remaining "open" for staleness purposes.
          if (event.data.toolUseId) openTools.delete(event.data.toolUseId);
          break;
        case 'turn-complete': {
          stopReason = event.data.stopReason;
          const u = event.data.usage;
          if (u) {
            usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens;
            usage.cacheReadTokens += u.cacheReadTokens; usage.cacheCreationTokens += u.cacheCreationTokens;
          }
          break;
        }
        case 'session-error':
          errorText = String(event.data.text ?? '').trim() || null;
          break;
        case 'user-interrupt':
          interrupted = true;
          break;
        case 'compact-summary':
          if (event.data.autoCompaction) {
            autoCompactionCount += 1;
            if (autoCompactionCount === 2 && !steered) {
              steered = true;
              // Injection is a MESSAGE, never a prompt edit — postSteer (Task 3)
              // queues this as a <steer> user-role history entry drained at the
              // next turn-loop iteration boundary, same as any other course
              // correction. A false return (no turn in flight) is fine to
              // ignore here: the child's turn just ended on its own, in which
              // case there is nothing left for a steer to interrupt.
              entry.session.postSteer(
                'You are running low on room even after summarizing. Stop new exploration — '
                + 'write up what you have and finish with your report now.',
              );
            }
          }
          break;
        default:
          break;   // every other type is persistence-only for this purpose
      }
    };
    entry.session.on('transcript-event', onEvent);

    /** Run one turn and wait for its whole drain to settle. */
    const runTurn = async (text: string): Promise<void> => {
      stopReason = undefined;
      sinceLastTool = '';
      const res = this.send(childId, text);
      // send() only refuses for reasons that cannot apply to a freshly-minted,
      // idle child (not live / queue full) — so this is a wiring bug, not a
      // model outcome, and it says exactly which refusal happened.
      if (res.status !== 'sent') throw new Error(`the specialist session ${childId} refused its turn (${res.status}${'reason' in res && res.reason ? `: ${res.reason}` : ''}).`);
      await entry.running;
    };

    /** The report this turn produced, or null when the child said nothing. */
    const reportSoFar = (): string | null => {
      const capped = stopReason === 'max_steps';
      const text = (sinceLastTool.trim() || (capped ? lastNonEmpty.trim() : '')) || '';
      if (!text) return null;
      // A step-capped child DID work and DID say something — the parent needs
      // both the partial finding and the fact that it is partial.
      return capped ? `${text}\n\n(stopped at its step limit)` : text;
    };

    /** Turn the run's terminal conditions into a typed throw. Checked after
     *  EVERY turn, because the nudge turn can fail the same ways the first one
     *  can. */
    const throwIfEnded = (): void => {
      if (errorText) throw new Error(`${errorText} (specialist session ${childId})`);
      if (interrupted) throw new Error(`the specialist was stopped before it could report (specialist session ${childId}).`);
      // The parent was destroyed / quiesced mid-run, which cascade-destroys its
      // children — there is no session left to nudge or read from.
      if (!this.live.has(childId)) throw new Error(`the specialist session ${childId} was torn down before it could report.`);
    };

    try {
      await runTurn(prompt);
      throwIfEnded();

      let report = reportSoFar();
      if (report === null) {
        // ONE nudge, then accept or fail (retry budget 1, spec §3). NOT when
        // the step cap is what ended the turn: that child has no steps left, so
        // another turn would burn the same cap again and still say nothing.
        if (stopReason === 'max_steps') {
          throw new Error(`the specialist hit its step limit without producing a report (specialist session ${childId}).`);
        }
        await runTurn(EMPTY_REPORT_NUDGE);
        throwIfEnded();
        report = reportSoFar();
      }
      if (report === null) {
        throw new Error(`the specialist finished without producing a report — no final message, even after one reminder (specialist session ${childId}).`);
      }
      // +1 for the step that produced the final message (see SpecialistRunResult).
      return { report, steps: steps + 1, usage };
    } finally {
      // Detach BEFORE the caller tears the session down, so this listener can
      // never observe teardown-time events (and so a run that throws does not
      // leave a listener attached to a session the caller may keep alive).
      entry.session.off('transcript-event', onEvent);
      // Task 7: cleared on EVERY exit path (success, throw, nudge, step-cap) —
      // a leaked interval per child would keep the process awake and pile up
      // across every specialist ever spawned.
      clearInterval(staleCheck);
    }
  }

  /** Wrap a child's last message as the tool result the parent model reads.
   *
   *  Three jobs: say WHO reported (the parent asked for a specialist, not for
   *  an anonymous blob of text), cap the body against what the parent can still
   *  afford, and point at the child's own transcript for anything that got cut.
   *  Text-only truncation in 1a — spilling the overflow to a file is 1b, which
   *  is why the pointer names the session rather than a path. */
  private formatSpecialistReport(i: { parentId: string; childId: string; specialist: SpecialistDefinition; title: string; body: string }): string {
    const parent = this.live.get(i.parentId)?.session;
    const window = parent?.contextWindowTokens ?? null;
    const used = parent?.contextUsedTokens ?? null;
    // Infinity = "we cannot measure the parent's occupancy" (a parent that has
    // not completed a step, or a provider that reports no usage). That degrades
    // to the definition's static cap — see computeReportBudget.
    const remaining = window != null && used != null ? window - used : Infinity;
    const budgetTokens = computeReportBudget({
      staticCapTokens: i.specialist.reportBudgetTokens,
      parentRemainingTokens: remaining,
      concurrentReporters: 1,   // 1a is FOREGROUND: the parent is blocked on exactly one child
    });
    const cut = truncateOutput(i.body, { maxChars: budgetTokens * APPROX_CHARS_PER_TOKEN });
    // Same notice vocabulary every other capped tool result uses, so a cut
    // report reads like a cut Bash/Grep result rather than a new dialect. The
    // hint has to be in the PARENT's vocabulary — it cannot re-read this child
    // (the session is torn down), so the advice is about the next delegation.
    const notice = cut.truncated
      ? composeNotice(undefined, { shown: cut.text.length, total: cut.totalChars },
        'delegate a narrower piece of work, or ask for a shorter report')
      : '';
    // Task 8: the header uses the child's assigned (fun) title, not the bare
    // displayName — the role id stays alongside it either way, so the parent
    // can always tell WHICH kind of specialist answered even though the name
    // is per-run.
    return `## Report from ${i.title} (${i.specialist.id})\n\n${cut.text}${notice}\n\n`
      + `[full transcript: specialist session ${i.childId}]`;
  }

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
    // Fix pass 2 (Task 13): ONE closure now answers both the context window
    // AND the engine's real parallel-slot count, from ONE call. Before this,
    // contextLengthFor and a separate slotCountFor closure shared one /props
    // reading through a variable scoped at the ipc-handlers.ts wiring site
    // (`lastLocalSlotReading`) — correct only if every caller awaited the two
    // closures back-to-back for the SAME binding with nothing else able to
    // run in between. Two local-engine sessions starting concurrently (or a
    // cloud binding's resolution landing between the two awaits, which resets
    // the shared variable to null) could silently read each other's slot
    // count, or read null instead of a real number — with no throw, just a
    // wrong cap. Collapsing to one return value removes the shared state
    // entirely: there is no ordering left to get wrong.
    private contextAndSlotsFor: (binding: ModelBinding) => Promise<{ contextLength: number | null; totalSlots: number | null }>,
    // Resolves a binding's provider TYPE (local-engine / openrouter / anthropic /
    // …) so the host can pick the right CapabilityProfile (Task 5). A binding
    // whose provider is unknown returns null → resolveContextAndProfile falls back
    // to a cloud-safe default. Positioned right after contextAndSlotsFor because
    // the two are resolved together for every create/resume/swap.
    private providerTypeFor: (binding: ModelBinding) => Promise<ProfileProviderType | null>,
    // Per-model vision fact read from the provider catalog's declared input
    // modalities (Task 6c). Today only OpenRouter's catalog can actually
    // answer this — everyone else (direct-key providers, openai-compatible,
    // local-engine) has no such signal, so the real (ipc-handlers) wiring
    // returns null for them WITHOUT ever touching the catalog, same as an
    // OpenRouter cache miss or fetch failure returning null after touching
    // it. null degrades to resolveProfile's existing registry/provider-default
    // behavior (DiscoveredModel.supportsVision left undefined) — it is never
    // allowed to throw. It is also never allowed to block a NON-OpenRouter
    // session start; for a live OpenRouter binding it does await the same
    // bounded (AbortSignal.timeout-guarded) catalog fetch contextAndSlotsFor
    // already pays for that binding, so it is not fully non-blocking there —
    // see the ipc-handlers.ts construction site for the short-circuit that
    // makes this true. Positioned right after providerTypeFor for the same
    // reason that one sits after contextAndSlotsFor: all three are resolved
    // together for every create/resume/swap.
    private visionSupportFor: (binding: ModelBinding) => Promise<boolean | null>,
    // Remembered "Always allow" rules, scoped per project (Task 12). Defaults to
    // a no-op so the many existing 5-arg test constructions (store, modelFactory,
    // contextAndSlotsFor, providerTypeFor, visionSupportFor — these five have no
    // defaults) still compile; the real wiring (ipc-handlers) injects a
    // PermissionStore over ~/.youcoded/.
    private permissionStore: RememberedRuleStore = NOOP_REMEMBERED_STORE,
    // Injected because electron's `app` is not importable in tests (mirrors the
    // other injected functions/values above). Feeds the <env> block of the
    // once-per-session assembled system prompt.
    private appVersion: string = '0.0.0-dev',
    // Runtime services threaded into every session's ToolContext (spec §3.2) —
    // WebSearch reads toolServices.search. Optional + LAST (of the pre-Task-6c
    // params) so existing 5/6/7-arg test constructions (the 5 required params,
    // optionally followed by permissionStore and/or appVersion) still compile;
    // the real wiring (ipc-handlers) injects { search: searchService }.
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
    // Task 2 (plan 1b) — backs the DelegationLedger this constructor builds
    // below. Takes a NativeHome rather than a pre-built DelegationLedger so
    // this file doesn't need to know delegation-ledger.ts's own construction
    // details beyond "give it a home". Optional + LAST, same reasoning as
    // toolServices/skillCatalog/mcpManager above: undefined here is what
    // every pre-existing 5..10-arg test construction gets for free (no
    // recording, not a NativeHome pointed at a real home dir by accident);
    // the real wiring (ipc-handlers.ts) always passes the shared nativeHome.
    nativeHome?: NativeHome,
  ) {
    super();
    // Re-emit broker asks/expirations so ipc-handlers can forward them to the
    // renderer + remote clients (see the 'hook-event' listener there).
    this.broker.on('hook-event', (event) => this.emit('hook-event', event));
    this.ledger = nativeHome ? new DelegationLedger(nativeHome) : undefined;
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

  /** Revoke ONE remembered "Always allow": disk first, then every live session's
   *  in-memory copy. Returns whether the store actually matched anything on disk
   *  — the renderer uses that to say "we couldn't find it" rather than reporting
   *  success against a list that had gone stale.
   *
   *  ONE ENTRY POINT ON PURPOSE. buildDecide() unions the on-disk rules with
   *  `rememberedFor` on EVERY decision, so a disk-only delete leaves a running
   *  session granting exactly what the user just revoked — the failure this whole
   *  feature exists to prevent. That is also why the naming differs from the
   *  store's: PermissionStore.remove / removeProject are DISK ONLY, while
   *  revokeRule / revokeProject are disk PLUS live memory. IPC handlers must call
   *  these, never the store's — "fixing the inconsistency" reintroduces the bug.
   *
   *  Matching is by SLUG, never by path equality: cwdToProjectSlug collapses ':',
   *  '\', '/' AND spaces all to '-', so two differently-spelled cwds ('/home/d/my
   *  project' and '/home/d/my-project') genuinely share one entry on disk — and
   *  must therefore both be cleared in memory too.
   *
   *  The in-memory filter compares the (tool, pattern, action) TRIPLE, not whole
   *  objects: a rule read back off disk carries a `grantedAt` key the in-memory
   *  copy never had, so an equality check would silently stop matching. */
  async revokeRule(slug: string, rule: PermissionRule): Promise<boolean> {
    const hit = await this.permissionStore.remove(slug, rule);
    for (const [sessionId, entry] of this.live) {
      if (cwdToProjectSlug(entry.cwd) !== slug) continue;
      const mem = this.rememberedFor.get(sessionId);
      if (!mem) continue;
      this.rememberedFor.set(sessionId, mem.filter(
        (r) => !(r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action),
      ));
    }
    return hit;
  }

  /** Revoke EVERY remembered rule for a project (the "clear all for this folder"
   *  control). Same disk-plus-live-memory contract and same slug matching as
   *  revokeRule — see its comment for why both halves are mandatory. */
  async revokeProject(slug: string): Promise<boolean> {
    const hit = await this.permissionStore.removeProject(slug);
    for (const [sessionId, entry] of this.live) {
      // delete, not set([]): an absent entry and an empty one read identically in
      // buildDecide (`?? []`), and deleting keeps the map from accumulating empties.
      if (cwdToProjectSlug(entry.cwd) === slug) this.rememberedFor.delete(sessionId);
    }
    return hit;
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
    // Fix pass 2 (Task 13): ONE call gets both the context window and the
    // engine's real slot count — see the contextAndSlotsFor constructor
    // param's comment for why this replaces two separately-injected closures
    // that used to share one /props reading through a variable at the
    // ipc-handlers.ts wiring site. There is nothing left to order: this is
    // the single await that produces both values for this binding.
    const { contextLength: raw, totalSlots } = await this.contextAndSlotsFor(binding);
    const discoveredSlots = totalSlots ?? undefined;
    const type = (await this.providerTypeFor(binding)) ?? 'openrouter';     // unknown → cloud-safe default
    // The registry ceiling (effectiveContextForModel) is a LOCAL-model concern: it
    // caps a small GGUF loaded at a too-large -c to its real trained window. But
    // matchKnownModel keys ONLY on the model-id regex, so a HOSTED model whose id
    // happens to match a local family (e.g. OpenRouter `qwen/qwen3.5-9b` matching
    // the local Qwen entry) would be wrongly clamped, capping a cloud window that
    // may be far larger. So resolve the provider type FIRST and only clamp locals;
    // cloud/hosted bindings pass their real window through unchanged.
    const contextLength = type === 'local-engine' ? effectiveContextForModel(raw, binding.modelId) : raw;
    // null (no source could answer — the closure's convention, matching
    // contextAndSlotsFor/providerTypeFor above) becomes undefined on the
    // DiscoveredModel, which is visionFor()'s OWN "not discovered" sentinel —
    // it then falls through to the registry/provider-type default exactly as
    // it did before this closure existed.
    const discoveredVision = (await this.visionSupportFor(binding)) ?? undefined;
    const profile = resolveProfile({
      providerType: type, modelId: binding.modelId, contextLength, supportsVision: discoveredVision,
      // Threads the engine's real slot reading into the known-model overlay's
      // concurrency clamp (capability-profile.ts's localSlotCap). undefined
      // for every non-local-engine binding — the ipc-handlers wiring never
      // queries the engine for those.
      totalSlots: discoveredSlots,
    });
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
      // Thread injected runtime services (WebSearch's SearchService, Task 6's
      // specialists collaborators) into the HarnessSession opts. `specialists`
      // is ALWAYS present (unlike `search`, which depends on an optional
      // constructor arg) — syncTaskTool's own profile.canDelegate /
      // isSpecialistChild gate is what actually decides whether the Task tool
      // is ever attached to see it, so there is no "host built without
      // specialist support" case to leave unset the way `toolServices` itself
      // conditionally omits `search`.
      toolServices: {
        ...(this.toolServices ?? {}),
        specialists: {
          reserve: (parentId: string, reserveOpts: { writer: boolean }) => this.reserveSpecialist(parentId, reserveOpts),
          release: (token: SpecialistReservation) => this.releaseReservation(token),
          trySpendSpawnBudget: (parentId: string) => this.trySpendSpecialistSpawnBudget(parentId),
          spawn: (parentId: string, spawnOpts: Parameters<NativeSessionHost['spawnSpecialist']>[1]) =>
            this.spawnSpecialist(parentId, spawnOpts),
        },
      },
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

  /** Task 5 (plan 1b): one line per NON-DELIVERED delegation for `sessionId`
   *  (its parent), or null when there's nothing to report — the zero-cost case
   *  for a session that never delegates. A record with `delivered: true` never
   *  appears: its report already rode into the parent's history, so restating
   *  it here would be stale noise, not a status.
   *
   *  `steps` is read straight off the ledger record, which Task 2's write path
   *  only ever sets AT COMPLETION (see spawnSpecialist's `update(...steps:
   *  run.steps...)`) — there is no live, per-child step counter surfaced
   *  anywhere a status line could read from without reaching into
   *  spawnSpecialist/createChild's own bookkeeping (out of this task's scope,
   *  and a different in-flight lane owns those methods). So a still-running
   *  child legitimately shows `step 0` until its next status-changing write;
   *  that is what the ledger actually knows, not a guessed number.
   *
   *  `stale` likewise only ever surfaces the ledger's own boolean (Task 7 sets
   *  it) — this method never re-derives staleness. The one exception is the
   *  "no activity for {m}m" minute count: the ledger stores no last-activity
   *  TIMESTAMP, only the boolean, so there is no exact duration to surface.
   *  What IS true by construction (native-session-host.ts's setStale) is that
   *  `stale` never flips true before SPECIALIST_IDLE_STALE_MS has elapsed with
   *  no activity — so that constant is reported as a floor ("at least this
   *  long"), not a measurement, and is never overstated. */
  private buildSpecialistStatus(sessionId: string, cwd: string): string | null {
    if (!this.ledger) return null;
    const lines = this.ledger.listFor(cwd, sessionId)
      .filter((r) => !r.delivered)
      .map((r) => {
        if (r.status === 'running') {
          const elapsedS = Math.max(0, Math.round((Date.now() - r.startedAt) / 1000));
          const staleNote = r.stale ? `, may be stuck — no activity for ${Math.round(SPECIALIST_IDLE_STALE_MS / 60_000)}m` : '';
          return `${r.title} (${r.agentType}): running — step ${r.steps ?? 0}, ${elapsedS}s${staleNote}`;
        }
        return `${r.title} (${r.agentType}): finished — report delivery pending`;
      });
    return lines.length > 0 ? lines.join('\n') : null;
  }

  /** Subscribe a freshly-built HarnessSession: forward its events to the
   *  renderer immediately, and enqueue each on the session's append chain. */
  private wire(sessionId: string, cwd: string, session: HarnessSession, mcpLease?: McpLease): void {
    const entry: LiveEntry = { session, cwd, appendChain: Promise.resolve(), queue: [], inFlight: false, mcpLease };
    this.live.set(sessionId, entry);
    this.retainModel(sessionId, session.binding.modelId); // ref-count this model
    // Task 5 (plan 1b): wired for ROOT sessions only — wire() is never called
    // for a specialist child (createChild has its own inline live.set, see its
    // "NOT wire()" comment), so a child never grows its own status block.
    session.setSpecialistStatus(() => this.buildSpecialistStatus(sessionId, cwd));
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

  /** Mint a SPECIALIST CHILD of a live session (plan 1a, spec §1/§5).
   *
   *  A specialist is an ordinary HarnessSession, not a new kind of object: same
   *  driver, same transcript events, its own JSONL. What makes it a child is
   *  (a) the header's parentage fields, (b) a COLD start — its system prompt is
   *  the specialist definition plus the <env> block for its work directory, and
   *  nothing at all from the parent conversation, and (c) a capability surface
   *  that can only ever be narrower than the parent's.
   *
   *  `prompt` and `parentToolCallId` are accepted here but deliberately not
   *  consumed yet: this call mints the child IDLE. Task 7's runSpecialist()
   *  delivers the prompt as the child's first user turn and stamps display
   *  copies of its events with parentToolCallId. They sit in the signature now
   *  so the Task tool (Task 6), which is written against this contract, has one
   *  call site rather than two.
   *
   *  Returns the child's id; throws (never returns a half-built child) when the
   *  parent isn't live or the work directory escapes the parent's. */
  async createChild(parentId: string, opts: {
    specialist: SpecialistDefinition;
    prompt: string;
    workDir: string;
    parentToolCallId: string;
  }): Promise<{ childId: string; title: string }> {
    const parent = this.live.get(parentId);
    // A child with no live parent has nobody to report to and nobody to tear it
    // down — refuse loudly rather than orphan a session.
    if (!parent) throw new Error(`Cannot start a specialist: parent session ${parentId} is not live.`);

    // Containment: the child may work in the parent's directory or a
    // subdirectory of it, never outside. Canonicalized through the SAME helper
    // the tool-layer guards use (forward slashes, `..` resolved, case-folded on
    // win32) so this check and checkPathGuard agree on what a path is; a raw
    // path.sep/startsWith comparison would disagree with the guards on Windows
    // and on any input containing `..`.
    const workDir = resolveP(opts.workDir, parent.cwd);
    if (!isUnderRoot(canonicalize(workDir, parent.cwd), canonicalize(parent.cwd, parent.cwd))) {
      throw new Error(`A specialist's work directory must be inside the parent session's directory (${parent.cwd}); got ${opts.workDir}.`);
    }

    const childId = randomUUID();
    // The child inherits the parent's preset (permission posture + manifest) and
    // its model — 1a always runs the child on the parent's binding.
    const preset = resolvePreset(this.presetIdFor.get(parentId));
    const binding = parent.session.binding;
    const { contextLength, profile } = await this.resolveContextAndProfile(binding);

    // Build the session BEFORE writing the header: everything below is fallible
    // synchronous work (assembleSystemPrompt shells out to git, buildTriggerIndex
    // walks the tree), and a throw after the header write would leave a session
    // file on disk for a child that never existed.
    const allowed = new Set(opts.specialist.allowedTools);
    const session = new HarnessSession(
      {
        sessionId: childId, cwd: workDir, binding, contextLength, profile,
        // STEP CAP: the definition's own budget, not the model-tier default.
        // harness-session reads opts.harness.limits?.maxSteps and falls back to
        // stepBudgetFor(modelId) — without this line stepCap would be decorative.
        harness: { ...preset.manifest, limits: { ...preset.manifest.limits, maxSteps: opts.specialist.stepCap } },
        // TOOLS: the definition's allowlist, filtered out of the same CORE_TOOLS
        // set every session is built from. The Task tool is structurally absent
        // because no definition lists it — that omission IS the depth-1 rule.
        tools: CORE_TOOLS.filter((t) => allowed.has(t.name)),
        // COLD START (spec §1): the specialist body replaces the preset body, and
        // the <env> block describes the CHILD's work directory. Nothing from the
        // parent's conversation crosses over — the brief in the first user turn
        // is the entire context the child gets.
        systemPrompt: assembleSystemPrompt({
          presetBody: opts.specialist.systemPrompt, cwd: workDir, appVersion: this.appVersion,
          promptVariant: profile.promptVariant, hasTools: profile.supportsTools,
          instructionBudgetTokens: profile.injectionBudgetTokens,
        }),
        // Project rules / nested instructions for the CHILD's directory. Project
        // state, not conversation state, so it does not violate the cold start —
        // and a Worker that edits files under rules the parent would have obeyed
        // must obey them too.
        triggers: buildTriggerIndex(workDir),
        // SKILL SUPPRESSION (cold-start contract): an explicit EMPTY catalog, not
        // an omission. syncSkillTool falls back to createSkillCatalog() — the full
        // installed catalog — whenever opts.skillCatalog is undefined, and it
        // re-syncs on every turn, so leaving this out would silently hand every
        // child the user's whole skill library.
        skillCatalog: { list: () => [], load: (id: string) => { throw new SkillNotFound(id, []); } },
        // MCP SUPPRESSION: create()/resume() call acquireMcp() at this point;
        // createChild deliberately never does, and passes no mcpServers — so no
        // MCP tools attach, and there is no lease for destroy() to release.
        // PERMISSIONS: the parent's full configured stack, capped by the
        // definition. Built against the PARENT's id AND the PARENT's cwd, never
        // workDir — buildDecide keys the session's live permission mode by id and
        // remembered "Always allow" rules by cwd, and those grants follow the
        // project, not a subtree of it.
        decide: buildChildDecide({
          parentDecide: this.buildDecide(parentId, parent.cwd, preset.presetRules),
          charter: opts.specialist.charter,
          allowedTools: opts.specialist.allowedTools,
          envelopeGranted: true,   // 1a foreground flow: the Task-tool ask was the consent
        }),
        // ASKS: a policy, NEVER the parent's broker. The broker would emit under
        // the CHILD's sessionId, which no window owns; the reducer drops asks for
        // unknown sessions and broker.ask()'s promise would never resolve, so the
        // child would hang silently until teardown (see child-ask-policy.ts).
        askUser: childAskPolicy(),
        ...(this.toolServices ? { toolServices: this.toolServices } : {}),
        // BELT-AND-SUSPENDERS (Task 6): syncTaskTool's SECOND, independent
        // gate against depth-2 delegation. allowedTools filtering above
        // already keeps 'Task' out of a child's tool set structurally (no
        // SpecialistDefinition lists it) — this flag means a bug in that
        // filtering alone still cannot let a specialist spawn its own
        // specialists.
        isSpecialistChild: true,
      },
      this.modelFactory,
    );

    // Task 8: draw this child's fun name from the PARENT's taken-set (never
    // global — see takenNamesOf's comment) and stamp it into the header's
    // existing `title` field. The transcript header/list machinery already
    // reads `title` for free (session-store.ts's list() title precedence),
    // so this needs no new plumbing beyond the header write below.
    let takenNames = this.takenNamesOf.get(parentId);
    if (!takenNames) { takenNames = new Set(); this.takenNamesOf.set(parentId, takenNames); }
    const { name, title } = assignSpecialistName(opts.specialist.id, takenNames);
    takenNames.add(name);

    await this.store.create({
      v: 1,
      sessionId: childId,
      harnessId: preset.manifest.id,
      binding,
      cwd: workDir,
      createdAt: Date.now(),
      title,
      parentSessionId: parentId,
      sessionKind: 'specialist',
      agentType: opts.specialist.id,
    });

    // NOT wire(). wire() re-emits the session's own events on the host emitter,
    // where ipc-handlers mints a conversation record and feeds the title feeder —
    // a child would surface as a conversation the user never started. The child
    // gets the persistence half only; the display half (stamped COPIES of the
    // three subagent event types, emitted under the PARENT's id) is Task 7.
    const entry: LiveEntry = {
      session, cwd: workDir, appendChain: Promise.resolve(), queue: [], inFlight: false,
      parentSessionId: parentId,
    };
    this.live.set(childId, entry);
    this.retainModel(childId, binding.modelId);
    let siblings = this.childrenOf.get(parentId);
    if (!siblings) { siblings = new Set(); this.childrenOf.set(parentId, siblings); }
    siblings.add(childId);
    session.on('transcript-event', (event: TranscriptEvent) => {
      // (1) PERSISTENCE — on the child's OWN chain, to the child's own JSONL,
      // with the ORIGINAL event (child sessionId) untouched. Same serialization
      // contract as wire()'s append, same swallow-and-log so one failed append
      // cannot wedge the chain. EVERY type lands here, including the ones that
      // are never re-emitted below: the child's file is the complete record the
      // report's "[full transcript: …]" pointer refers to.
      entry.appendChain = entry.appendChain
        .then(() => this.store.append(workDir, event))
        .catch((err) => {
          log('ERROR', 'NativeSessionHost', 'child append failed', {
            sessionId: childId, type: event.type, error: String(err),
          });
        });
      // (2) DISPLAY (Task 7) — a stamped COPY, for the three types the
      // renderer's subagent card consumes and NOTHING else (see
      // SUBAGENT_DISPLAY_TYPES for what a stamped turn-complete would break).
      // The copy rides under the PARENT's session id, because that is the
      // session a window actually owns; `parentAgentToolUseId` threads it into
      // the parent's Task tool card and `agentId` identifies which child spoke.
      // The original is never mutated — the persisted event above and this copy
      // are two different objects on purpose.
      if (!SUBAGENT_DISPLAY_TYPES.has(event.type)) return;
      this.emit('transcript-event', {
        ...event,
        sessionId: parentId,
        data: { ...event.data, parentAgentToolUseId: opts.parentToolCallId, agentId: childId },
      } satisfies TranscriptEvent);
    });
    return { childId, title };
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
      // are runtime state, never persisted. readImageFromDisk re-reads any
      // persisted attachment paths so images survive resume (#290 follow-up fix 2).
      session.seedHistory(rebuildHistory(this.store.readEvents(sessionId, cwd), readImageFromDisk));
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
  send(sessionId: string, text: string, attachments: string[] = []): NativeSendResult {
    const entry = this.live.get(sessionId);
    if (!entry) return { status: 'failed', reason: 'not-live' };
    if (entry.inFlight) {
      if (entry.queue.length >= SEND_QUEUE_LIMIT) return { status: 'failed', reason: 'queue-full' };
      // Task 11: mint a stable id per queued entry so the renderer can target
      // this exact message later with removeQueued() (Cancel/Edit before send).
      const queueId = randomUUID();
      entry.queue.push({ id: queueId, text, attachments });
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
      setImmediate(() => { void this.runTurns(sessionId, entry, { text, attachments }).then(resolve, resolve); });
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
  private async runTurns(sessionId: string, entry: LiveEntry, first: SendUnit | (() => Promise<void>)): Promise<void> {
    let next: SendUnit | (() => Promise<void>) | undefined = first;
    while (next !== undefined) {
      try {
        if (typeof next === 'function') await next();
        else await entry.session.send(next.text, next.attachments);
      } catch (err) {
        log('ERROR', 'NativeSessionHost', 'send failed', { sessionId, error: String(err) });
      }
      // Destroy() may have removed/replaced the entry mid-turn — stop draining then.
      if (this.live.get(sessionId) !== entry) return;
      // .text: queue entries are {id, text} (Task 11) — the id only matters to
      // removeQueued(); shift() here is what makes a removed entry unreachable.
      next = entry.queue.shift();
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
    // Cascade to this session's FOREGROUND specialist children only (plan 1b,
    // external review 2026-08-12 — deliberate change from 1a's unconditional
    // cascade): a foreground child's turn is work the parent is BLOCKED on
    // (the Task tool awaits it), so Stop has to reach it or the parent keeps
    // waiting on a run the user just cancelled. A BACKGROUND child is not
    // blocking anything — the Task call already returned — so stopping the
    // parent's TURN must not fire a researcher that is still working;
    // background survives the Stop button (destroy()/quiesce() teardown below
    // still takes every child down, foreground or background). Foreground/
    // background is read synchronously off the ledger (interrupt() cannot do
    // disk I/O — see childrenOf's own comment above); no record for a child
    // (an untracked child, or a test host with no ledger injected) defaults
    // to cascading, matching every child's behavior before this change.
    //
    // Interrupt only — NOT destroy: this method is synchronous (destroy() is
    // async, and a floating destroy promise in the main process is exactly the
    // bug class `npm run lint` gates on), and Stop means "abort the work", not
    // "delete the session". The child is torn down with its parent (destroy /
    // quiesce below, both async) or by the Task tool's own finalizer.
    const parentCwd = this.live.get(sessionId)?.cwd;
    // Fix (review round 2, Finding 3): hoisted OUT of the loop below. This
    // used to call listFor() — a synchronous file read + JSON parse of the
    // WHOLE sidecar — once PER CHILD, so a parent with N children did N
    // redundant reads of the identical file on every Stop press. One read,
    // shared by every iteration below via a childId lookup.
    const records = this.ledger && parentCwd ? this.ledger.listFor(parentCwd, sessionId) : [];
    for (const childId of this.childrenOf.get(sessionId) ?? []) {
      const rec = records.find((r) => r.childId === childId);
      if (rec?.background) continue; // still working — the Stop button doesn't touch it
      this.interrupt(childId);
    }
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
    // (1b) Tear down specialist children before quiescing this session: a
    // running child keeps appending to ITS file and keeps the parent's Task call
    // pending, both of which contradict what quiesce promises the caller (no
    // further work for this session once it resolves). Safe to await here —
    // the queue is already cleared, so nothing can start a new parent turn.
    await this.destroyChildrenOf(sessionId);
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

  /** True only when we can AFFIRM this native session has no work in flight —
   *  no turn running and nothing queued behind one. Consumed by the transcript
   *  replay handler: a replayed transcript ends wherever the process died, so
   *  its last tool_use may have no result, and the renderer needs to know
   *  whether that card is stale history or a genuinely running tool (the same
   *  replay fires when a window re-docks a live, mid-turn session).
   *  Unknown/non-native ids answer false — never claim idle we can't prove. */
  isIdle(sessionId: string): boolean {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    return !entry.inFlight && entry.queue.length === 0;
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

  /** Cascade-cancel: interrupt then destroy every live specialist child of this
   *  session. Called from destroy() and quiesce(). Reads the in-memory
   *  childrenOf map only — teardown never does disk I/O to find its children.
   *  Interrupt-then-destroy (rather than destroy alone) so a child paused
   *  mid-turn unwinds its loop before its stream is torn out from under it —
   *  the same order interrupt() and destroy() already use for one session. */
  private async destroyChildrenOf(sessionId: string): Promise<void> {
    const children = this.childrenOf.get(sessionId);
    if (!children) return;
    this.childrenOf.delete(sessionId);
    // Task 8: this parent's name-draw state dies with its children set — a
    // reused/new set of children under this parent id (there isn't one in
    // practice, but nothing here should assume it) starts the pool fresh.
    this.takenNamesOf.delete(sessionId);
    // Task 2 (plan 1b): captured before the loop below — `sessionId`'s live
    // entry is still present here (this is called from destroy()/quiesce()
    // BEFORE either drops the parent's own live entry).
    const parentCwd = this.live.get(sessionId)?.cwd;
    for (const childId of [...children]) {
      this.interrupt(childId);
      // Any child still in this set is, by construction, still 'running' in
      // the ledger — a completed/failed foreground child already tore itself
      // down (and de-registered from childrenOf) in spawnSpecialist's own
      // finally. FIRE-AND-FORGET (not awaited): destroy()/quiesce() (this
      // method's only callers) can themselves be invoked without an await
      // from a sync caller, and a lock-contended ledger write must never make
      // an unrelated caller's teardown appear to hang. .catch(log) turns a
      // failed write into a log line instead of an unhandled rejection.
      if (this.ledger && parentCwd) {
        this.ledger.update(parentCwd, sessionId, childId, { status: 'interrupted', endedAt: Date.now() })
          .catch((e) => log('ERROR', 'NativeSessionHost', 'failed to record an interrupted delegation', { childId, parentId: sessionId, error: String(e) }));
      }
      await this.destroy(childId);
    }
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
    // Capture the entry SYNCHRONOUSLY, before the child cascade below awaits —
    // the MCP release at the bottom of this method depends on tearing down the
    // generation this call captured (see the comment there), and that property
    // must survive the new await, not just the ones that were already here.
    const entry = this.live.get(sessionId);
    // Specialist children go next, and unconditionally — before the not-live
    // early return, because a child must never outlive its parent even if the
    // parent's own entry is already gone (a double destroy, or a teardown
    // racing one).
    await this.destroyChildrenOf(sessionId);
    if (!entry) return;
    // De-register from the parent's child set (this session IS a child when
    // parentSessionId is set) so a destroyed child isn't chased again later.
    if (entry.parentSessionId) this.childrenOf.get(entry.parentSessionId)?.delete(sessionId);
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
    // Task 6 — drop this parent's specialist bookkeeping too, so a slot/writer
    // reservation can never outlive the session that made it (destroyChildrenOf
    // above already tore down any children BEFORE we get here, but a slot could
    // still be reserved from an in-flight Task call this destroy() interrupted).
    this.specialistSlots.delete(sessionId);
    this.activeWriterChild.delete(sessionId);
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
