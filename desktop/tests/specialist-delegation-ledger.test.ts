// Tests for DelegationLedger — the durable, per-parent record of every
// specialist delegation (plan 1b Task 2). Real filesystem (temp dir per
// test), same fixture style as permission-store.test.ts: NativeHome(dir)
// against a fresh temp root, no fs mocking.
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { DelegationLedger, OWNER, isOwnerAlive, type DelegationRecord } from '../src/main/harness/specialists/delegation-ledger';

let home: NativeHome; let ledger: DelegationLedger; let dir: string;
const CWD = '/some/project';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-ledger-'));
  home = new NativeHome(dir);
  ledger = new DelegationLedger(home);
});

// Minimal valid record, override per test. `owner: OWNER` matches what the
// real host always stamps (this very process); tests that need a DEAD owner
// override it explicitly.
function makeRecord(overrides: Partial<DelegationRecord> & { childId: string }): DelegationRecord {
  return {
    parentToolCallId: 'tc-1',
    agentType: 'explorer',
    title: 'Fig the Explorer',
    workDir: CWD,
    description: 'Explores the codebase',
    background: false,
    status: 'running',
    startedAt: Date.now(),
    delivered: false,
    owner: OWNER,
    missedSteers: [],
    ...overrides,
  };
}

describe('DelegationLedger', () => {
  it('recordStart + listFor round-trips a record', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    const rows = ledger.listFor(CWD, 'p1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ childId: 'c1', agentType: 'explorer', status: 'running' });
  });

  it('listFor returns [] when no file exists yet', () => {
    expect(ledger.listFor(CWD, 'never-delegated')).toEqual([]);
  });

  it('update patches one record by childId and leaves siblings alone', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c2' }));
    await ledger.update(CWD, 'p1', 'c1', { status: 'completed', endedAt: 999, rawReport: 'done' });

    const rows = ledger.listFor(CWD, 'p1');
    const c1 = rows.find((r) => r.childId === 'c1');
    const c2 = rows.find((r) => r.childId === 'c2');
    expect(c1).toMatchObject({ status: 'completed', endedAt: 999, rawReport: 'done' });
    expect(c2).toMatchObject({ status: 'running' }); // untouched sibling
  });

  it('update caps rawReport at RAW_REPORT_CAP_CHARS (full body survives elsewhere)', async () => {
    const { RAW_REPORT_CAP_CHARS } = await import('../src/main/harness/specialists/delegation-ledger');
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    const huge = 'x'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    await ledger.update(CWD, 'p1', 'c1', { rawReport: huge });
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(rec?.rawReport?.length).toBe(RAW_REPORT_CAP_CHARS);
  });

  it('claimUndelivered LEASES the oldest completed+undelivered record — delivered stays false', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'running-one', status: 'running', startedAt: 50 }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'old', status: 'completed', startedAt: 100 }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'new', status: 'completed', startedAt: 200 }));

    const first = await ledger.claimUndelivered(CWD, 'p1');
    expect(first?.childId).toBe('old');
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'old');
    expect(rec?.delivered).toBe(false);
    expect(rec?.claimedBy).toEqual(OWNER);
    expect(typeof rec?.claimedAt).toBe('number');
  });

  it('claimUndelivered returns null when nothing is eligible', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'still-running', status: 'running' }));
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  it('confirmDelivered flips delivered; a confirmed record is never claimable again', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', startedAt: 100 }));
    const claimed = await ledger.claimUndelivered(CWD, 'p1');
    expect(claimed?.childId).toBe('c1');

    await ledger.confirmDelivered(CWD, 'p1', 'c1');
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(rec?.delivered).toBe(true);

    // Nothing left to claim — the only record is now delivered.
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  it('releaseClaim clears the lease so a failed injection retries', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', startedAt: 100 }));
    const claimed = await ledger.claimUndelivered(CWD, 'p1');
    expect(claimed?.childId).toBe('c1');

    await ledger.releaseClaim(CWD, 'p1', 'c1');
    const released = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(released?.claimedBy).toBeUndefined();
    expect(released?.delivered).toBe(false); // release never delivers — only confirmDelivered may

    // A second claim picks the SAME record back up.
    const reclaimed = await ledger.claimUndelivered(CWD, 'p1');
    expect(reclaimed?.childId).toBe('c1');
  });

  it('a record leased by a DEAD owner is claimable again — crash between claim and injection re-delivers', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({
      childId: 'the-orphaned-one',
      status: 'completed',
      startedAt: 100,
      delivered: false,
      claimedBy: { pid: 999_999, instanceId: 'a-process-that-is-long-gone' },
      claimedAt: 1,
    }));
    const rec = await ledger.claimUndelivered(CWD, 'p1');
    expect(rec?.childId).toBe('the-orphaned-one');
    // The re-claim re-stamps OUR owner, not the dead one.
    expect(rec?.claimedBy).toEqual(OWNER);
  });

  it('a record leased by a LIVE owner (not us) is NOT claimable', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({
      childId: 'someone-else-has-it',
      status: 'completed',
      startedAt: 100,
      delivered: false,
      // Our own live pid+a different instanceId — same process, different
      // "instance" — isOwnerAlive can't use the fast path but process.kill
      // on our own real pid succeeds, so this reads as genuinely alive.
      claimedBy: { pid: process.pid, instanceId: 'some-other-instance' },
      claimedAt: 1,
    }));
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  it('isOwnerAlive: our own stamp is alive; an absurd pid+instanceId is not', () => {
    expect(isOwnerAlive(OWNER)).toBe(true);
    expect(isOwnerAlive({ pid: 999_999, instanceId: 'nonexistent-owner' })).toBe(false);
  });
});
