import { describe, it, expect } from 'vitest';
import { estimateFit, checkDiskSpace, checkMemoryForLoad } from '../src/main/models/fit-estimator';

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
  it('a resume is judged on the bytes REMAINING, not the whole download', () => {
    // 100 GB download, 80 GB already on disk, 30 GB free: refusing this would
    // push the user to delete the very partial that makes it fit (spec §3.7).
    expect(checkDiskSpace(100 * GB, 30 * GB)).not.toBeNull();          // from scratch: refused
    expect(checkDiskSpace(100 * GB, 30 * GB, 80 * GB)).toBeNull();     // resuming: allowed
  });

  it('still refuses when even the remaining bytes do not fit', () => {
    expect(checkDiskSpace(100 * GB, 5 * GB, 80 * GB)).toMatch(/needs about 20\.0 GB/);
  });
});

describe('checkMemoryForLoad (create-time guard)', () => {
  const MEM = 32 * GB;
  it('ok: a small model with nothing loaded', () => {
    const v = checkMemoryForLoad({ chosenBytes: 4 * GB, totalMemBytes: MEM, totalVramBytes: null, loadedBytes: 0 });
    expect(v.verdict).toBe('ok');
    expect(v.headline).toBe('');
  });
  it('BLOCKS (too-large) a model that cannot fit even alone', () => {
    // 40GB + 2GB overhead > 32GB machine (RAM-only) → too-large even at loadedBytes 0.
    const v = checkMemoryForLoad({ chosenBytes: 40 * GB, totalMemBytes: MEM, totalVramBytes: null, loadedBytes: 0 });
    expect(v.verdict).toBe('too-large');
    expect(v.headline).toMatch(/too large/i);
    expect(v.detail).toMatch(/smaller model|quant/i);
  });
  it('WARNS (tight) when it fits alone but over-commits alongside loaded models', () => {
    // 12GB fits alone on 32GB, but 12 + 18 already-loaded + 2 overhead = 32 > 0.85*32.
    const v = checkMemoryForLoad({ chosenBytes: 12 * GB, totalMemBytes: MEM, totalVramBytes: null, loadedBytes: 18 * GB });
    expect(v.verdict).toBe('tight');
    expect(v.headline).toMatch(/memory/i);
    expect(v.detail).toMatch(/unload|swap/i);
  });
  it('does not warn when nothing else is loaded (loadedBytes 0), even if largish', () => {
    // 20GB alone on 32GB is not too-large; with nothing loaded it must not warn.
    const v = checkMemoryForLoad({ chosenBytes: 20 * GB, totalMemBytes: MEM, totalVramBytes: null, loadedBytes: 0 });
    expect(v.verdict).toBe('ok');
  });
  it('dedicated VRAM raises capacity, upgrading a tight verdict to ok', () => {
    const args = { chosenBytes: 20 * GB, totalMemBytes: MEM, loadedBytes: 15 * GB };
    // RAM-only (32GB): 20 + 15 + 2 = 37 > 0.85*32 (27.2) → tight.
    expect(checkMemoryForLoad({ ...args, totalVramBytes: null }).verdict).toBe('tight');
    // +16GB dedicated VRAM → capacity 48GB: 37 < 0.85*48 (40.8) → ok.
    expect(checkMemoryForLoad({ ...args, totalVramBytes: 16 * GB }).verdict).toBe('ok');
  });
});
