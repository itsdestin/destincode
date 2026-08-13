// DelegationLedger — the durable, per-parent record of every specialist
// delegation (plan 1b Task 2). Plan 1a's foreground flow could get away with
// in-memory-only bookkeeping: the Task tool call blocks until the child
// reports, so the report never has to survive anything. A BACKGROUND
// specialist (plan 1b) keeps working after its Task call returns, so its
// eventual report needs somewhere durable that (a) survives an app restart
// and (b) every later consumer — background delivery, restart recovery, the
// per-turn status block, card replay (Tasks 4/5/6/7/9) — can read the same
// way. This is that somewhere: one sidecar JSON file per parent session,
// written EXCLUSIVELY through NativeHome.mutateJson (the one lock-guarded
// read-modify-write path — dev instance and built app can share one home dir,
// same cross-process risk every other ~/.youcoded/ JSON file has).
//
// A CLAIM IS A LEASE, NOT A DELIVERY (external review 2026-08-12). The
// earlier design had claimUndelivered() eagerly set delivered: true — but if
// the app died between that claim and the claimed report actually reaching
// the parent's conversation (the injected turn), the report was gone
// forever: on disk it already read as "delivered", so nothing would ever
// retry it. That is the exact failure mode this ledger exists to close.
// claimUndelivered() below only ever stamps claimedBy/claimedAt; delivered
// stays false until confirmDelivered() is called AFTER the injected turn has
// actually run. releaseClaim() clears the lease when a delivery attempt fails
// so the next pass can retry. isOwnerAlive() means a lease held by a dead
// process (the app crashed mid-delivery) does not block redelivery forever.
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { NativeHome } from '../../native-home';
import { cwdToProjectSlug } from '../../transcript-watcher';

export type OwnerStamp = { pid: number; instanceId: string };

export interface DelegationRecord {
  childId: string;
  parentToolCallId: string;
  agentType: string;
  title: string;
  workDir: string;
  description: string;
  background: boolean;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  endedAt?: number;
  steps?: number;
  /** UNFORMATTED body, capped at RAW_REPORT_CAP_CHARS. The full body lives in
   *  the child's own JSONL transcript and, from Task 4, a reportPath spill
   *  file when it exceeds the cap. */
  rawReport?: string;
  /** Spill file — written at COMPLETION when the body exceeds the ledger cap
   *  (Task 4), or at delivery on budget truncation (Task 10). */
  reportPath?: string;
  /** status 'failed' — the real thrown message, never a guessed cause
   *  (error-message-standards.md). */
  failureText?: string;
  /** Flipped ONLY after the injected turn has actually run. See the module
   *  comment: a claim is a lease, not a delivery. */
  delivered: boolean;
  /** Delivery LEASE — present does not mean delivered, and does not even mean
   *  the leaseholder is still alive (see isOwnerAlive). */
  claimedBy?: OwnerStamp;
  claimedAt?: number;
  owner: OwnerStamp;
  missedSteers: string[];
  stale?: boolean;
}

// Full body cap for the copy that rides IN the ledger file. mutateJson is a
// read-modify-write of the ENTIRE file — every status-block read and restart
// pass loads and re-serializes the whole thing — so one chatty specialist's
// report must not be allowed to make that file (and every future read/rewrite
// of it) expensive. The full text always survives elsewhere: the child's own
// JSONL transcript, and (Task 4) a spill file at reportPath.
export const RAW_REPORT_CAP_CHARS = 64_000;

const FILE_VERSION = 1 as const;
interface LedgerFile { v: 1; delegations: DelegationRecord[] }
const EMPTY: LedgerFile = { v: FILE_VERSION, delegations: [] };

// Captured ONCE at module load — this process's identity for the lifetime of
// the run. `instanceId` (a random UUID, never persisted or derived from pid)
// is what lets isOwnerAlive recognize "this is literally the process asking"
// without a syscall; `pid` is the fallback for recognizing OTHER processes
// (see isOwnerAlive below for why pid alone isn't trustworthy in general).
export const OWNER: OwnerStamp = { pid: process.pid, instanceId: randomUUID() };

/**
 * Is the process that stamped `owner` still around?
 *
 * Same-instanceId is an exact match — no syscall needed, and it is always
 * correct because instanceId is a fresh random UUID per process (never reused
 * across a restart, unlike pid). Otherwise, a plain `process.kill(pid, 0)`
 * liveness probe (same precedent as sync-service.ts's isPidAlive, :441-454):
 * signal 0 sends nothing, it only checks whether the pid exists, and a throw
 * (ESRCH) means it doesn't.
 *
 * WHY no /proc/<pid>/stat start-time comparison (external review
 * 2026-08-12): that would close the one gap process.kill can't — pid REUSE,
 * where the OS hands a dead owner's old pid to a new, unrelated process
 * before we ever re-check. But /proc's field 22 is jiffies-since-boot, while
 * OwnerStamp carries no comparable field on purpose: converting between the
 * two is fiddly, platform-specific (no /proc on macOS/Windows), and prone to
 * either never firing or false-firing. The residual PID-reuse risk this
 * leaves is an ACCEPTED tradeoff: worst case is one stale `running` record
 * that lingers in the status block and stays interruptible via its task_id —
 * annoying, never lossy (a dead-but-undetected owner's lease is never
 * confused with a real delivery, so no report is ever silently dropped).
 */
export function isOwnerAlive(owner: OwnerStamp): boolean {
  if (owner.instanceId === OWNER.instanceId) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class DelegationLedger {
  constructor(private home: NativeHome) {}

  private relPath(parentCwd: string, parentId: string): string {
    return path.join('sessions', cwdToProjectSlug(parentCwd), `${parentId}.delegations.json`);
  }

  /** Tolerate a missing/corrupt/wrong-shape file as "no delegations yet" —
   *  same contract as permission-store.ts — rather than throwing; a
   *  hand-edited or half-written sidecar heals on the next write. */
  private coerce(cur: unknown): LedgerFile {
    return cur && Array.isArray((cur as LedgerFile).delegations) ? (cur as LedgerFile) : EMPTY;
  }

  async recordStart(parentCwd: string, parentId: string, rec: DelegationRecord): Promise<void> {
    await this.home.mutateJson(this.relPath(parentCwd, parentId), (cur) => {
      const data = this.coerce(cur);
      return { v: FILE_VERSION, delegations: [...data.delegations, rec] };
    });
  }

  async update(parentCwd: string, parentId: string, childId: string, patch: Partial<DelegationRecord>): Promise<void> {
    // Cap rawReport HERE, not at recordStart — completion is the only place a
    // full report body ever arrives (recordStart runs before the child has
    // said anything). See RAW_REPORT_CAP_CHARS above for why the cap exists.
    const cappedPatch: Partial<DelegationRecord> =
      patch.rawReport !== undefined && patch.rawReport.length > RAW_REPORT_CAP_CHARS
        ? { ...patch, rawReport: patch.rawReport.slice(0, RAW_REPORT_CAP_CHARS) }
        : patch;
    await this.home.mutateJson(this.relPath(parentCwd, parentId), (cur) => {
      const data = this.coerce(cur);
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => (d.childId === childId ? { ...d, ...cappedPatch } : d)),
      };
    });
  }

  listFor(parentCwd: string, parentId: string): DelegationRecord[] {
    return this.coerce(this.home.readJson(this.relPath(parentCwd, parentId))).delegations;
  }

  async claimUndelivered(parentCwd: string, parentId: string): Promise<DelegationRecord | null> {
    let claimed: DelegationRecord | null = null;
    await this.home.mutateJson(this.relPath(parentCwd, parentId), (cur) => {
      const data = this.coerce(cur);
      // Eligible: completed, not yet delivered, and either never claimed or
      // claimed by an owner that isn't around anymore (a crash between claim
      // and the injected turn reaching the parent — see the module comment:
      // a claim is a LEASE, not a delivery, so a dead owner's claim must not
      // block redelivery forever).
      const eligible = data.delegations.filter(
        (d) => d.status === 'completed' && !d.delivered && (!d.claimedBy || !isOwnerAlive(d.claimedBy))
      );
      if (eligible.length === 0) return data;
      const target = eligible.reduce((oldest, d) => (d.startedAt < oldest.startedAt ? d : oldest));
      // delivered stays FALSE — this stamps the LEASE only. Only
      // confirmDelivered (after the report is ACTUALLY injected into the
      // parent's conversation) may flip delivered to true.
      claimed = { ...target, claimedBy: OWNER, claimedAt: Date.now() };
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => (d.childId === target.childId ? claimed! : d)),
      };
    });
    return claimed;
  }

  async confirmDelivered(parentCwd: string, parentId: string, childId: string): Promise<void> {
    // The injected turn has ACTUALLY run at this point — only now is it safe
    // to say the report was delivered.
    await this.update(parentCwd, parentId, childId, { delivered: true });
  }

  async releaseClaim(parentCwd: string, parentId: string, childId: string): Promise<void> {
    // Delivery attempt failed (or was abandoned) after claiming — clear the
    // lease so a later pass can claim it again. Explicit undefined (rather
    // than omitting the keys) so the patch actually overwrites whatever lease
    // is on disk; JSON.stringify drops undefined-valued keys on write, so the
    // record reads back exactly like "never claimed".
    await this.update(parentCwd, parentId, childId, { claimedBy: undefined, claimedAt: undefined });
  }
}
