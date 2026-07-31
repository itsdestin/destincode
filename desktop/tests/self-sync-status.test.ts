// desktop/tests/self-sync-status.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSelfLastSyncEpochSec } from '../src/main/sync-spaces/self-sync-status';

describe('deriveSelfLastSyncEpochSec', () => {
  it('prefers sync-spaces evidence (ms → wire seconds)', () => {
    expect(deriveSelfLastSyncEpochSec(1_785_446_434_842, null)).toBe(1_785_446_434);
  });
  it('falls back to the legacy marker for Drive/iCloud-only installs', () => {
    expect(deriveSelfLastSyncEpochSec(null, '1785000000')).toBe(1_785_000_000);
  });
  it('takes the max when both systems have synced', () => {
    expect(deriveSelfLastSyncEpochSec(1_785_446_434_842, '1785000000')).toBe(1_785_446_434);
    expect(deriveSelfLastSyncEpochSec(1_784_000_000_000, '1785000000')).toBe(1_785_000_000);
  });
  it('null when neither exists (→ UI "last seen" fallback), and on garbage', () => {
    expect(deriveSelfLastSyncEpochSec(null, null)).toBeNull();
    expect(deriveSelfLastSyncEpochSec(null, 'not-a-number')).toBeNull();
    expect(deriveSelfLastSyncEpochSec(null, '')).toBeNull();
  });
});
