// Lease client (Plan 2b, Task 6). Owns the per-held-session heartbeat renew
// timers, the acquire/release/query/takeover operations, and a best-effort
// lease-FILE fallback so a device can still answer "who holds this session?"
// while the SyncHub is transiently disconnected.
//
// Design notes (why this shape):
//   - The HUB is the source of truth. The lease file at
//     Personal/Leases/<sessionId>.json is a best-effort mirror consulted ONLY
//     when the hub returns null (down). It uses the same 300s stale rule via the
//     LOCAL clock — good enough because a wrong file answer just means one extra
//     query round-trip, never data loss.
//   - NEVER block the caller and NEVER throw from a fire-and-forget path. A hub
//     request that returns null (disconnected) is treated as an optimistic local
//     hold rather than a failure — sync must degrade gracefully, never wedge.
//   - Every timer is unref()'d so a lingering renew timer can't keep the Electron
//     main process alive on quit; all fs ops are try/caught (best-effort).
import * as fs from 'fs';
import * as path from 'path';
import type { LeaseResult } from '../sync-hub-socket';

// Match the worker's contract: 300s lease expiry, 30s heartbeat.
const LEASE_TTL_MS = 300_000;
const RENEW_MS = 30_000;

export interface LeaseClientOpts {
  deviceId: string;
  deviceName: string;
  // Returns the Personal sync-space root, or null when managed roots are
  // unavailable (sync disabled / not yet initialized). Null => skip all file ops.
  personalRoot: () => string | null;
  // Injected transport (the SyncHub socket's request()). Resolves a LeaseResult,
  // or null when the hub is disconnected / timed out — never rejects.
  hubRequest: (op: string, sessionId: string, deviceId: string) => Promise<LeaseResult | null>;
  // Upward callback the caller (Task 8 service) supplies to trigger holder-side
  // teardown (interrupt -> mirror -> release -> destroy). `from` is OPTIONAL — a
  // deliberate deviation from the plan's non-optional shape: renew-failure
  // teardowns attribute the takeover from the reply's holder when the hub
  // reports one, but a race where the holder is unknown still has no `from`.
  onTakeoverRequest: (sessionId: string, from?: { deviceId: string; device: string }) => void;
}

export interface LeaseQueryResult {
  held: boolean;
  device?: string;
  // The per-install device id of the holder (NOT the label). `self` is derived
  // from it — a caller MUST NOT infer self-identity from `device` (the hostname
  // label), which collides when two installs share a hostname (the dev instance
  // + built app, or two same-hostname machines). deviceId is unique per install.
  deviceId?: string;
  // True when the holder is THIS install (holder deviceId === our deviceId). This
  // is the correct "is it me?" signal — see deviceId above for why the label isn't.
  self?: boolean;
  expiresAt?: number;
  source: 'hub' | 'file' | 'none';
}

export interface LeaseClient {
  acquire(sessionId: string): Promise<LeaseResult | null>;
  release(sessionId: string): Promise<void>;
  query(sessionId: string): Promise<LeaseQueryResult>;
  takeover(sessionId: string): Promise<LeaseResult | null>;
  // Inbound: the service calls this when the hub delivers a takeover-request
  // lease-event. Filtered HERE because the client is the only thing that knows
  // which sessions THIS device holds.
  handleTakeoverRequest(sessionId: string, from?: { deviceId: string; device: string }): void;
  isHeld(sessionId: string): boolean;
  destroy(): void;
}

interface LeaseFileContent { deviceId: string; device: string; expiresAt: number }

export function createLeaseClient(opts: LeaseClientOpts): LeaseClient {
  // sessionId -> renew timer. Membership IS "this device holds the lease".
  const held = new Map<string, NodeJS.Timeout>();
  // sessionId -> monotonically-increasing generation. Bumped on every acquire /
  // fresh renew loop. A renew tick captures the gen it was scheduled under and
  // bails if the current gen has moved on — this is what makes a re-acquire
  // genuinely idempotent even if a PRIOR tick for the same session is still
  // awaiting hubRequest (its resumed schedule() would otherwise leak a second
  // heartbeat loop, double-renewing).
  const gen = new Map<string, number>();

  // ---- lease-file helpers (all best-effort, all try/caught) ----

  function leaseFile(sessionId: string): string | null {
    const root = opts.personalRoot();
    if (!root) return null; // managed roots unavailable — hub is the primary path anyway
    return path.join(root, 'Leases', `${sessionId}.json`);
  }

  function writeLeaseFile(sessionId: string, expiresAt: number): void {
    const file = leaseFile(sessionId);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body: LeaseFileContent = { deviceId: opts.deviceId, device: opts.deviceName, expiresAt };
      fs.writeFileSync(file, JSON.stringify(body));
    } catch { /* best-effort: file fallback is a nicety, not a correctness guarantee */ }
  }

  function deleteLeaseFile(sessionId: string): void {
    const file = leaseFile(sessionId);
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }

  function readLeaseFile(sessionId: string): LeaseFileContent | null {
    const file = leaseFile(sessionId);
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
        return { deviceId: String(parsed.deviceId ?? ''), device: String(parsed.device ?? ''), expiresAt: parsed.expiresAt };
      }
      return null;
    } catch { return null; } // missing / malformed -> treat as no lease
  }

  // ---- renew timer ----

  // Clears the renew TIMER only — it does NOT remove `held`/`gen` membership.
  // Callers must pair it with `held.delete(sessionId)` (and let the gen bump on
  // the next acquire) to fully release the session.
  function stopTimer(sessionId: string): void {
    const t = held.get(sessionId);
    if (t) clearTimeout(t);
  }

  function startRenewTimer(sessionId: string): void {
    // Bump the generation so any in-flight tick from a prior loop becomes a
    // no-op when it resumes. `myGen` is captured by this loop's schedule/tick.
    const myGen = (gen.get(sessionId) ?? 0) + 1;
    gen.set(sessionId, myGen);

    // Self-rescheduling setTimeout (not setInterval) so an async renew that runs
    // long can't stack overlapping renews. Each tick reschedules itself.
    const schedule = () => {
      const timer = setTimeout(() => { void renewTick(sessionId); }, RENEW_MS);
      timer.unref?.(); // don't keep the Electron main process alive just for a renew
      held.set(sessionId, timer);
    };

    async function renewTick(sessionId: string): Promise<void> {
      // The whole body is wrapped so an unexpected throw in a timer callback can
      // never become a fatal unhandled rejection in Electron main.
      try {
        // Stale-generation guard: a re-acquire (or fresh renew loop) since this
        // tick was scheduled means we're an orphaned loop — bail silently so we
        // never leak a second heartbeat that double-renews.
        if (gen.get(sessionId) !== myGen) return;
        if (!held.has(sessionId)) return; // released/destroyed between scheduling and firing
        const r = await opts.hubRequest('renew', sessionId, opts.deviceId);
        if (gen.get(sessionId) !== myGen) return; // superseded while the renew was in flight
        if (!held.has(sessionId)) return; // released while the renew was in flight

        if (r && !r.ok) {
          // A failed renew has TWO distinct causes and only one is a takeover:
          //   holder present (≠ us) → another device force-acquired it (spec §3
          //     step 5). Tear down and attribute the takeover to that device.
          //   holder null → the lease lazily EXPIRED server-side because our
          //     heartbeat was suspended past the 300s TTL (system sleep, screen
          //     lock, OS throttling an idle process) and NOBODY has taken it.
          //     That's a lapse, not a takeover — re-acquire in place. Treating
          //     it as a takeover showed a spurious "session was taken over on
          //     another device" on idle sessions (2026-07-16).
          const holder = r.holder;
          if (holder && holder.deviceId && holder.deviceId !== opts.deviceId) {
            stopTimer(sessionId);
            held.delete(sessionId);
            deleteLeaseFile(sessionId);
            opts.onTakeoverRequest(sessionId, { deviceId: holder.deviceId, device: holder.device });
            return;
          }

          const re = await opts.hubRequest('acquire', sessionId, opts.deviceId);
          if (gen.get(sessionId) !== myGen) return; // superseded while re-acquiring
          if (!held.has(sessionId)) return; // released while re-acquiring
          if (re && !re.ok) {
            // Raced: another device claimed the lapsed lease between the expiry
            // and our re-acquire. Genuine loss — tear down with attribution.
            stopTimer(sessionId);
            held.delete(sessionId);
            deleteLeaseFile(sessionId);
            const h = re.holder;
            opts.onTakeoverRequest(
              sessionId,
              h && h.deviceId && h.deviceId !== opts.deviceId
                ? { deviceId: h.deviceId, device: h.device }
                : undefined,
            );
            return;
          }
          // Re-acquired (re.ok), or hub went down mid-recovery (re === null) —
          // on the null path we hold optimistically, same never-block rule as
          // the transient-null branch below.
          writeLeaseFile(sessionId, re?.holder?.expiresAt ?? Date.now() + LEASE_TTL_MS);
          schedule();
          return;
        }

        if (r && r.ok) {
          // Still ours — extend the file fallback with the hub's fresh deadline.
          writeLeaseFile(sessionId, r.holder?.expiresAt ?? Date.now() + LEASE_TTL_MS);
        } else {
          // r === null: hub transiently disconnected. Do NOT drop the lease on a
          // blip — keep renewing and keep the file fallback fresh with a local
          // deadline (never-block / tolerate transient hub loss).
          writeLeaseFile(sessionId, Date.now() + LEASE_TTL_MS);
        }
        schedule(); // reschedule the next heartbeat only if we still hold it
      } catch {
        // Swallow — a renew failure must never crash main. Reschedule so a one-off
        // error doesn't silently kill the heartbeat, but only if we're still the
        // live loop (gen unchanged) and still hold the session.
        if (gen.get(sessionId) === myGen && held.has(sessionId)) schedule();
      }
    }

    schedule();
  }

  // ---- public ops ----

  return {
    async acquire(sessionId) {
      let res: LeaseResult | null = null;
      try { res = await opts.hubRequest('acquire', sessionId, opts.deviceId); }
      catch { res = null; } // never throw from acquire

      if (res && !res.ok) {
        // Someone else holds it. Don't start a timer, don't write a file — the
        // caller inspects res.holder to decide whether to request a takeover.
        return res;
      }

      // res.ok OR res === null (hub down). On the disconnected path we hold
      // OPTIMISTICALLY: sync must never block on the hub, so we take a local hold
      // and let the next renew reconcile once the hub is back.
      const expiresAt = res?.holder?.expiresAt ?? Date.now() + LEASE_TTL_MS;
      // Genuinely idempotent re-acquire: stopTimer clears the old timer, and
      // startRenewTimer bumps the generation so any PRIOR renew tick still
      // awaiting hubRequest becomes a no-op when it resumes (no leaked 2nd loop).
      stopTimer(sessionId);
      held.delete(sessionId);
      writeLeaseFile(sessionId, expiresAt);
      startRenewTimer(sessionId);
      return res ?? { ok: true, op: 'acquire', sessionId, holder: { deviceId: opts.deviceId, device: opts.deviceName, expiresAt } };
    },

    async release(sessionId) {
      // Stop local state FIRST so a late renew can't re-arm anything, then tell
      // the hub best-effort. Release must never throw.
      stopTimer(sessionId);
      held.delete(sessionId);
      deleteLeaseFile(sessionId);
      try { await opts.hubRequest('release', sessionId, opts.deviceId); } catch { /* best-effort */ }
    },

    async query(sessionId) {
      let r: LeaseResult | null = null;
      try { r = await opts.hubRequest('get', sessionId, opts.deviceId); }
      catch { r = null; }

      if (r !== null) {
        // Hub answered — authoritative. `self` keys on the per-install deviceId,
        // never the hostname label (which collides across installs).
        if (r.holder) return {
          held: true,
          device: r.holder.device,
          deviceId: r.holder.deviceId,
          expiresAt: r.holder.expiresAt,
          self: r.holder.deviceId === opts.deviceId,
          source: 'hub',
        };
        return { held: false, self: false, source: 'hub' };
      }

      // Hub down — consult the file fallback with the 300s stale rule (local clock).
      // The lease file stores the holder's deviceId too, so self keys on it here as well.
      const file = readLeaseFile(sessionId);
      if (file && file.expiresAt > Date.now()) {
        return {
          held: true,
          device: file.device,
          deviceId: file.deviceId,
          expiresAt: file.expiresAt,
          self: file.deviceId === opts.deviceId,
          source: 'file',
        };
      }
      // Missing or expired file => free.
      return { held: false, self: false, source: 'none' };
    },

    async takeover(sessionId) {
      // Thin passthrough: the DO relays this as a takeover-request to the current
      // holder, who answers by releasing. The requester (Task 9) then polls query.
      try { return await opts.hubRequest('takeover', sessionId, opts.deviceId); }
      catch { return null; }
    },

    handleTakeoverRequest(sessionId, from) {
      // Only act if THIS device currently holds the session — otherwise the
      // request isn't for us (the hub broadcasts to the whole account).
      if (!held.has(sessionId)) return;
      // The callback is caller-supplied (untrusted) and dispatched synchronously
      // from the service's hub-event handler — a throw here would propagate to
      // Electron main. Swallow so a bad handler can never crash the process.
      try { opts.onTakeoverRequest(sessionId, from); } catch { /* never crash main */ }
    },

    isHeld(sessionId) { return held.has(sessionId); },

    destroy() {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    },
  };
}
