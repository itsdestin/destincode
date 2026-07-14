import { describe, it, expect } from 'vitest';
import { estimateFit, checkDiskSpace } from '../src/main/models/fit-estimator';

const GB = 1024 ** 3;

describe('estimateFit', () => {
  // ---- RAM-only path (no confident GPU → totalVram null) ----
  it('RAM-only: 4GB model on 16GB should run well', () => {
    expect(estimateFit(4 * GB, 16 * GB, null)).toEqual({
      fit: 'fits', label: 'Should run well on this machine',
    });
  });
  // NOTE: corrected from the plan's 9GB (arithmetic slip: 9+2=11GB = 68.75% of
  // 16GB ≤ 70% → 'fits', contradicting the exhaustive boundaries test below).
  // 10GB is the smallest model that is genuinely 'tight' on 16GB (12GB need >
  // 11.2GB fits-threshold, ≤ 14.4GB tight-threshold). Implementation unchanged.
  it('RAM-only: 10GB on 16GB is tight', () => {
    expect(estimateFit(10 * GB, 16 * GB, null)).toEqual({
      fit: 'tight', label: 'Will be tight — close other apps first',
    });
  });
  it('RAM-only: 20GB on 16GB is too large', () => {
    expect(estimateFit(20 * GB, 16 * GB, null).fit).toBe('too-large');
  });
  it('RAM-only boundaries: need ≤ 70% = fits; ≤ 90% = tight (need = size + 2GB)', () => {
    expect(estimateFit(5 * GB, 10 * GB, null).fit).toBe('fits');
    expect(estimateFit(5.1 * GB, 10 * GB, null).fit).toBe('tight');
    expect(estimateFit(7 * GB, 10 * GB, null).fit).toBe('tight');
    expect(estimateFit(7.1 * GB, 10 * GB, null).fit).toBe('too-large');
  });

  // ---- GPU-aware path (Amendment 2026-07-14 F) ----
  it('GPU fully offloaded: 16GB model on a 24GB GPU runs fast — even though RAM-only would reject it', () => {
    // RAM-only (16GB RAM) would say too-large; the GPU upgrades the verdict.
    expect(estimateFit(16 * GB, 16 * GB, null).fit).toBe('too-large');
    expect(estimateFit(16 * GB, 16 * GB, 24 * GB)).toEqual({
      fit: 'fits', label: 'Runs fast — fits on your GPU',
    });
  });
  it('GPU split: 20GB model, 8GB VRAM, 32GB RAM → runs across GPU + memory', () => {
    const r = estimateFit(20 * GB, 32 * GB, 8 * GB);
    expect(r.fit).toBe('fits');
    expect(r.label).toMatch(/gpu/i);
  });
  it('GPU present but model dwarfs VRAM + RAM → still too large', () => {
    expect(estimateFit(60 * GB, 16 * GB, 8 * GB).fit).toBe('too-large');
  });
  it('SAFETY BIAS: null VRAM never upgrades — identical to RAM-only', () => {
    expect(estimateFit(16 * GB, 16 * GB, null).fit).toBe('too-large');
  });
});

describe('checkDiskSpace', () => {
  it('passes when free space exceeds size + 5% margin, fails below', () => {
    expect(checkDiskSpace(10 * GB, 20 * GB)).toBeNull();
    expect(checkDiskSpace(10 * GB, 10.4 * GB)).toMatch(/free space/i);
  });
});
