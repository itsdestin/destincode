import { describe, it, expect } from 'vitest';
import {
  estimateFit, checkDiskSpace, checkMemoryForLoad, kvCacheBytes, contextLengthFor,
  poolFromDevices, availableMemoryBytes, isResident, WORKING_HEADROOM_BYTES,
  type MemoryCheckInputs,
} from '../src/main/models/fit-estimator';
import type { GgufHeader } from '../src/main/models/gguf-header';

const GB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A header with nothing in it, so each test states ONLY the fields it is about. */
function header(over: Partial<GgufHeader> = {}): GgufHeader {
  return {
    architecture: 'test', blockCount: null, contextLength: null,
    headCount: null, headCountLayers: null, headCountKv: null, headCountKvLayers: null,
    embeddingLength: null, keyLength: null, valueLength: null,
    keyLengthSwa: null, valueLengthSwa: null, slidingWindow: null,
    slidingWindowPattern: null, slidingWindowPatternLayers: null,
    fullAttentionInterval: null, nextnPredictLayers: null,
    recurrentLayers: null, sharedKvLayers: null, slidingLayers: null,
    contextBytesIsUpperBound: false, archBytes: 0,
    ...over,
  };
}

const F16 = { k: 'f16', v: 'f16' } as const;
const Q8K = { k: 'q8_0', v: 'f16' } as const;   // what the engine is spawned with today
const BLOCK = 34 / 32;                          // q8_0's 34-byte, 32-value block

describe('kvCacheBytes — the per-layer formula (§D2)', () => {
  it('plain full-attention model: layers × kvHeads × (dK×kBytes + dV×vBytes) × tokens, +block overhead', () => {
    const h = header({ blockCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128 });
    const kv = kvCacheBytes(h, 4096, F16);
    expect(kv.bytes).toBe(32 * 8 * (128 * 2 + 128 * 2) * 4096 * BLOCK);
    expect(kv.isUpperBound).toBe(false);
  });

  it('an 8-bit KEY cache halves the key half and nothing else', () => {
    const h = header({ blockCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128 });
    expect(kvCacheBytes(h, 4096, Q8K).bytes).toBe(32 * 8 * (128 * 1 + 128 * 2) * 4096 * BLOCK);
  });

  it('head counts come from the PER-LAYER array, never the scalar (gemma-4-12b: 8 sliding / 1 full)', () => {
    // The scalar is the array's MAXIMUM, so reading it would size all 48 layers
    // at 8 KV heads — eightfold on the full-attention ones.
    const layers = 48;
    const perLayer = Array.from({ length: layers }, (_, il) => ((il + 1) % 6 === 0 ? 1 : 8));
    const h = header({
      blockCount: layers, headCountKv: 8, headCountKvLayers: perLayer,
      keyLength: 256, valueLength: 256,
    });
    const perToken = (heads: number) => heads * (256 * 2 + 256 * 2);
    const expected = perLayer.reduce((sum, heads) => sum + perToken(heads) * 4096, 0) * BLOCK;
    expect(kvCacheBytes(h, 4096, F16).bytes).toBe(expected);
    // And it really is smaller than the flat-scalar reading it replaces.
    const flat = layers * perToken(8) * 4096 * BLOCK;
    expect(kvCacheBytes(h, 4096, F16).bytes).toBeLessThan(flat);
  });

  it('recurrent/linear layers hold no attention KV at all', () => {
    const recurrent = Array.from({ length: 32 }, (_, il) => (il + 1) % 4 !== 0); // 24 of 32
    const h = header({ blockCount: 32, headCountKv: 4, keyLength: 256, valueLength: 256, recurrentLayers: recurrent });
    expect(kvCacheBytes(h, 32768, Q8K).bytes).toBe(8 * 4 * (256 * 1 + 256 * 2) * 32768 * BLOCK);
  });

  it('shared_kv_layers drops the TRAILING n layers, not the leading ones', () => {
    // The trailing layers are given a distinct head count, so counting the wrong
    // end of the stack produces a different number rather than the same one.
    const perLayer = [4, 4, 4, 4, 4, 9, 9, 9, 9, 9];
    const h = header({
      blockCount: 10, headCountKv: 9, headCountKvLayers: perLayer,
      keyLength: 128, valueLength: 128, sharedKvLayers: 5,
    });
    const perToken = (heads: number) => heads * (128 * 2 + 128 * 2);
    expect(kvCacheBytes(h, 1024, F16).bytes).toBe(5 * perToken(4) * 1024 * BLOCK);
  });

  it('sliding layers keep min(context, window + ubatch) tokens, padded to 256, at the _swa widths', () => {
    // 5 sliding + 5 full, Gemma 4's half-width sliding keys/values.
    const sliding = [true, true, true, true, true, false, false, false, false, false];
    const h = header({
      blockCount: 10, headCountKv: 1, keyLength: 512, valueLength: 512,
      keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 1024, slidingLayers: sliding,
    });
    // llama-kv-cache-iswa.cpp:52 — GGML_PAD(min(size_base, n_swa + n_ubatch), 256),
    // n_ubatch 512: 1024 + 512 = 1536, already a multiple of 256.
    const slidingTokens = 1536;
    const expected = (5 * (256 * 2 + 256 * 2) * slidingTokens + 5 * (512 * 2 + 512 * 2) * 32768) * BLOCK;
    expect(kvCacheBytes(h, 32768, F16).bytes).toBe(expected);
  });

  it('the ubatch term is REAL memory: dropping it under-counts a sliding model', () => {
    const sliding = [true, true, true, true];
    const h = header({
      blockCount: 4, headCountKv: 8, keyLength: 256, valueLength: 256,
      slidingWindow: 1024, slidingLayers: sliding,
    });
    const withUbatch = 4 * 8 * (256 * 2 + 256 * 2) * (1024 + 512) * BLOCK;
    const windowOnly = 4 * 8 * (256 * 2 + 256 * 2) * 1024 * BLOCK;
    expect(kvCacheBytes(h, 32768, F16).bytes).toBe(withUbatch);
    expect(kvCacheBytes(h, 32768, F16).bytes).toBeGreaterThan(windowOnly);
  });

  it('a sliding window wider than the context never costs more than the context', () => {
    const h = header({
      blockCount: 4, headCountKv: 8, keyLength: 128, valueLength: 128,
      slidingWindow: 1_000_000, slidingLayers: [true, true, true, true],
    });
    expect(kvCacheBytes(h, 4096, F16).bytes).toBe(4 * 8 * (128 * 2 + 128 * 2) * 4096 * BLOCK);
  });

  it('a context that is not a multiple of 256 rounds UP, the way llama.cpp allocates', () => {
    const h = header({ blockCount: 1, headCountKv: 1, keyLength: 128, valueLength: 128 });
    expect(kvCacheBytes(h, 4000, F16).bytes).toBe(1 * 1 * (128 * 2 + 128 * 2) * 4096 * BLOCK);
  });

  it('an unread header falls back to a context-scaled ceiling and says so', () => {
    const at32k = kvCacheBytes(null, 32768, F16);
    expect(at32k.isUpperBound).toBe(true);
    expect(at32k.bytes).toBe(2 * GB);
    // A 128k context on an unknown model is four times the cache, not the same one.
    expect(kvCacheBytes(null, 131072, F16).bytes).toBe(8 * GB);
  });

  it('a header the reader could not fully understand stays an upper bound', () => {
    const h = header({ blockCount: 8, headCountKv: 4, keyLength: 128, valueLength: 128, contextBytesIsUpperBound: true });
    expect(kvCacheBytes(h, 4096, F16).isUpperBound).toBe(true);
  });

  it('a layer whose head count is unknown falls back rather than summing a partial cache', () => {
    // A partial sum would be an UNDER-count, the direction that turns tight into
    // a wrong fits.
    const h = header({ blockCount: 4, headCountKv: null, keyLength: 128, valueLength: 128 });
    const kv = kvCacheBytes(h, 32768, F16);
    expect(kv.isUpperBound).toBe(true);
    expect(kv.bytes).toBe(2 * GB);
  });
});

// ---------------------------------------------------------------------------

/** A machine with an 8 GB graphics pool and 32 GB of system memory free.
 *  Typed as the create-time guard's inputs, which is estimateFit's plus the
 *  dismissal record, so one helper feeds both. */
function inputs(over: Partial<MemoryCheckInputs> = {}): MemoryCheckInputs {
  return {
    modelBytes: 4 * GB, kvBytes: 0, contextLength: 32768,
    poolBytes: 8 * GB, poolIsGpu: true, availableBytes: 32 * GB, loadedBytes: 0,
    ...over,
  };
}

describe('estimateFit — the four tiers (§D2)', () => {
  it('need = model + vision + KV + 512 MB working headroom', () => {
    expect(WORKING_HEADROOM_BYTES).toBe(512 * MIB);
    // 6 GB model + 1 GB vision + 0.5 GB KV + 0.5 GB headroom = 8 GB = exactly the
    // pool, so it is 'tight'; one byte less of KV is still tight (> 90% of pool).
    const at = (kv: number) => estimateFit(inputs({ modelBytes: 6 * GB, visionBytes: GB, kvBytes: kv })).fit;
    expect(at(0.5 * GB)).toBe('tight');
    expect(at(0.5 * GB + 1)).toBe('tight');       // over the pool → the split tier, still tight
    expect(at(0)).toBe('tight');                  // 7.5 GB > 8 × 0.9 = 7.2
    expect(estimateFit(inputs({ modelBytes: 6 * GB, visionBytes: 0, kvBytes: 0 })).fit).toBe('fits');
  });

  it('fits: entirely inside 90% of the free pool', () => {
    const r = estimateFit(inputs({ modelBytes: 6 * GB, kvBytes: GB }));   // 7.5 ≤ 7.2? no
    expect(r.fit).toBe('tight');
    const ok = estimateFit(inputs({ modelBytes: 6 * GB, kvBytes: 0.5 * GB }));  // 7.0 ≤ 7.2
    expect(ok.fit).toBe('fits');
    expect(ok.label).toBe('Runs fast — fits on your GPU');
  });

  it('tight: over 90% of the pool but still inside it', () => {
    const r = estimateFit(inputs({ modelBytes: 7 * GB, kvBytes: 0 }));    // 7.5 GB of an 8 GB pool
    expect(r.fit).toBe('tight');
    expect(r.label).toBe('Will be tight — close other apps first');
  });

  it('tight: OVER the pool but inside pool + available — the split that really runs', () => {
    // 12 GB model, 8 GB pool, 32 GB free: -ngl auto offloads what fits and runs
    // the rest on the CPU. Blocking this would stop a model that answers fine.
    const r = estimateFit(inputs({ modelBytes: 12 * GB, kvBytes: GB }));
    expect(r.fit).toBe('tight');
    expect(r.label).toMatch(/splits across your GPU/i);
  });

  it('too-large: past the pool AND the memory available right now', () => {
    const r = estimateFit(inputs({ modelBytes: 60 * GB, kvBytes: 0 }));
    expect(r.fit).toBe('too-large');
    expect(r.label).toBe('Too large for this machine');
  });

  it('resident models come off the pool, and never take it below zero', () => {
    expect(estimateFit(inputs({ modelBytes: 6 * GB, loadedBytes: 0 })).fit).toBe('fits');
    expect(estimateFit(inputs({ modelBytes: 6 * GB, loadedBytes: 4 * GB })).fit).toBe('tight');
    // A pool already over-committed is zero, not negative — the model is then
    // scored against system memory alone, which is exactly what would happen.
    expect(estimateFit(inputs({ modelBytes: 6 * GB, loadedBytes: 999 * GB })).fit).toBe('tight');
    expect(estimateFit(inputs({ modelBytes: 6 * GB, loadedBytes: 999 * GB, availableBytes: 0 })).fit)
      .toBe('too-large');
  });

  it('the KV term may raise a verdict to tight, NEVER to too-large (R1-10)', () => {
    // A model that fits on its own but whose 128k cache would blow past
    // everything: it is a warning, not a hard block, because lowering the
    // context length is exactly what the advice line tells the user to do.
    const r = estimateFit(inputs({ modelBytes: 30 * GB, kvBytes: 100 * GB, availableBytes: 32 * GB }));
    expect(r.fit).toBe('tight');
    // Without the model fitting on its own it IS too-large — the clamp is not a
    // blanket "never block".
    expect(estimateFit(inputs({ modelBytes: 100 * GB, kvBytes: 100 * GB })).fit).toBe('too-large');
  });

  it('a CPU-only pool never claims the model fits on a GPU', () => {
    const r = estimateFit(inputs({ modelBytes: 6 * GB, kvBytes: 0.5 * GB, poolIsGpu: false, poolBytes: 8 * GB }));
    expect(r.fit).toBe('fits');
    expect(r.label).toBe('Should run well on this machine');
    expect(estimateFit(inputs({ modelBytes: 12 * GB, poolIsGpu: false })).label)
      .toBe('Will be tight — close other apps first');
  });
});

describe('estimateFit — the breakdown the size bubble reads (R8, R1-25, R32)', () => {
  it('carries the model, the vision file, the context share and its length', () => {
    const r = estimateFit(inputs({ modelBytes: 6 * GB, visionBytes: GB, kvBytes: 0.25 * GB, contextLength: 32768 }));
    expect(r.breakdown).toMatchObject({
      modelBytes: 6 * GB, visionBytes: GB, contextBytes: 0.25 * GB, contextLength: 32768,
    });
  });

  it('omits visionBytes for a text-only model, so the bubble has no 0.0 GB row', () => {
    expect(estimateFit(inputs()).breakdown?.visionBytes).toBeUndefined();
  });

  it("advice appears on tight and too-large, never on fits", () => {
    const advice = "Lower this model's context length in its Settings to shrink this.";
    expect(estimateFit(inputs({ modelBytes: 6 * GB, kvBytes: 0.5 * GB })).breakdown?.advice).toBeUndefined();
    expect(estimateFit(inputs({ modelBytes: 7 * GB })).breakdown?.advice).toBe(advice);
    expect(estimateFit(inputs({ modelBytes: 60 * GB })).breakdown?.advice).toBe(advice);
  });

  it('an estimated context share is flagged so the bubble can say "up to"', () => {
    expect(estimateFit(inputs({ kvIsUpperBound: true })).breakdown?.contextBytesIsUpperBound).toBe(true);
    expect(estimateFit(inputs()).breakdown?.contextBytesIsUpperBound).toBeUndefined();
  });
});

describe('the pool a model is scored against (§D2)', () => {
  it('is the first GPU device the engine reported', () => {
    // The real line on this machine:
    //   Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)
    expect(poolFromDevices(
      [{ backend: 'Vulkan0', name: 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)', totalMiB: 86016, freeMiB: 83660, isGpu: true }],
      { totalMemBytes: 128 * GB },
    )).toEqual({ poolBytes: 86016 * MIB, poolIsGpu: true });
  });

  it('trusts the install\'s own isGpu flag over anything guessed here', () => {
    // The name here is one nothing in this file would recognise as software —
    // the flag the engine install set is the only thing that says so.
    const devices = [
      { backend: 'Vulkan0', name: 'Mesa Software Device', totalMiB: 124406, isGpu: false },
      { backend: 'Vulkan1', name: 'NVIDIA GeForce RTX 4090', totalMiB: 24564, isGpu: true },
    ];
    expect(poolFromDevices(devices, { totalMemBytes: 128 * GB }).poolBytes).toBe(24564 * MIB);
  });

  it('skips the CPU device and software rasterisers even in a marker with no flag', () => {
    const devices = [
      { backend: 'CPU0', name: 'AMD Ryzen', totalMiB: 130000 },
      { backend: 'Vulkan0', name: 'llvmpipe (LLVM 19)', totalMiB: 130000 },
      { backend: 'Vulkan1', name: 'NVIDIA GeForce RTX 4090', totalMiB: 24564 },
    ];
    expect(poolFromDevices(devices, { totalMemBytes: 128 * GB }).poolBytes).toBe(24564 * MIB);
  });

  it('a device whose memory was never measured (null) is no pool, never a zero one', () => {
    // A null read as 0 would make every model too-large — the hard block that
    // refuses to create a session at all.
    const unmeasured = [{ backend: 'Vulkan0', name: 'Some GPU', totalMiB: null, freeMiB: null, isGpu: true }];
    expect(poolFromDevices(unmeasured, { totalMemBytes: 32 * GB }))
      .toEqual({ poolBytes: 32 * GB, poolIsGpu: false });
    // …and a second, measured device is still used.
    expect(poolFromDevices(
      [...unmeasured, { backend: 'Vulkan1', name: 'Real GPU', totalMiB: 8192, freeMiB: 8000, isGpu: true }],
      { totalMemBytes: 32 * GB },
    ).poolBytes).toBe(8192 * MIB);
  });

  it('falls back to detected VRAM, then to total RAM, and only then stops claiming a GPU', () => {
    // No marker devices at all — every install made before the engine started
    // recording them.
    expect(poolFromDevices(null, { totalMemBytes: 32 * GB, detectedVramBytes: 8 * GB }))
      .toEqual({ poolBytes: 8 * GB, poolIsGpu: true });
    expect(poolFromDevices(undefined, { totalMemBytes: 32 * GB, detectedVramBytes: null }))
      .toEqual({ poolBytes: 32 * GB, poolIsGpu: false });
    // A marker with a devices key we cannot read is the same as none.
    expect(poolFromDevices({ nonsense: true }, { totalMemBytes: 32 * GB }).poolIsGpu).toBe(false);
    expect(poolFromDevices([{ backend: 'Vulkan0', name: 'GPU', totalMiB: 0, isGpu: true }], { totalMemBytes: 32 * GB }).poolIsGpu)
      .toBe(false);
  });
});

describe('memory available right now — one reader per platform (§D2)', () => {
  it('Linux reads MemAvailable out of /proc/meminfo', () => {
    const meminfo = 'MemTotal:       131299568 kB\nMemFree:         6690268 kB\nMemAvailable:    81691368 kB\n';
    expect(availableMemoryBytes({
      platform: 'linux', readFileSync: () => meminfo, freemem: () => 1,
    })).toBe(81691368 * 1024);
  });

  it('macOS sums vm_stat free + inactive + purgeable at its own page size', () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               100.',
      'Pages active:                            9999.',
      'Pages inactive:                            50.',
      'Pages purgeable:                            5.',
    ].join('\n');
    expect(availableMemoryBytes({
      platform: 'darwin', runCommand: () => vmStat, freemem: () => 1,
    })).toBe((100 + 50 + 5) * 16384);
  });

  it('Windows uses free memory only — an under-count, so it over-warns', () => {
    expect(availableMemoryBytes({ platform: 'win32', freemem: () => 3 * GB })).toBe(3 * GB);
  });

  it('a reader that throws falls back to free memory rather than guessing', () => {
    expect(availableMemoryBytes({
      platform: 'linux', readFileSync: () => { throw new Error('no /proc'); }, freemem: () => 2 * GB,
    })).toBe(2 * GB);
    expect(availableMemoryBytes({ platform: 'darwin', runCommand: () => 'nothing useful', freemem: () => 2 * GB }))
      .toBe(2 * GB);
  });
});

describe('what counts as resident (R1-14)', () => {
  it('loaded and loading are resident; sleeping and unloaded are not', () => {
    expect(isResident('loaded')).toBe(true);
    // Mid-load memory is being taken this second — leaving it out is the
    // under-count that says a second model fits.
    expect(isResident('loading')).toBe(true);
    // A slept model's memory has been FREED by the router.
    expect(isResident('sleeping')).toBe(false);
    expect(isResident('unloaded')).toBe(false);
  });
});

describe('contextLengthFor (§D3)', () => {
  const models = { 'gemma-4-E2B-it-Q8_0': { contextLength: 131072 }, 'Qwen3.5-9B-Q8_0': { contextLength: null } };
  it("uses the model's own setting when it has one, else the engine-wide default", () => {
    expect(contextLengthFor('gemma-4-E2B-it-Q8_0', models, 32768)).toBe(131072);
    expect(contextLengthFor('Qwen3.5-9B-Q8_0', models, 32768)).toBe(32768);
    expect(contextLengthFor('never-configured', models, 32768)).toBe(32768);
  });
  it('survives a settings section that does not exist yet, or is malformed', () => {
    expect(contextLengthFor('x', null, 32768)).toBe(32768);
    expect(contextLengthFor('x', undefined, 32768)).toBe(32768);
    expect(contextLengthFor('x', { x: 'nonsense' }, 32768)).toBe(32768);
    expect(contextLengthFor('x', { x: { contextLength: -5 } }, 32768)).toBe(32768);
  });
});

describe('checkMemoryForLoad (create-time guard)', () => {
  const base = () => inputs({ modelBytes: 4 * GB, kvBytes: 0.5 * GB, availableBytes: 32 * GB, poolBytes: 80 * GB });

  it('ok: a model that fits in the memory free right now', () => {
    const v = checkMemoryForLoad(base());
    expect(v.verdict).toBe('ok');
    expect(v.headline).toBe('');
  });

  it('the headline is the ONE numbers line the warning opens to (R28)', () => {
    const v = checkMemoryForLoad(inputs({
      modelBytes: 9 * GB, visionBytes: GB, kvBytes: 4 * GB, contextLength: 32768,
      loadedBytes: 5 * GB, availableBytes: 6 * GB, poolBytes: 80 * GB,
    }));
    expect(v.verdict).toBe('tight');
    expect(v.headline).toBe(
      '9.0 GB model + 1.0 GB vision file + 4.0 GB for 32k context, with 5.0 GB already loaded.',
    );
  });

  it('says "up to" when the context share is an estimate, never a fake exact figure', () => {
    const v = checkMemoryForLoad(inputs({
      modelBytes: 9 * GB, kvBytes: 4 * GB, kvIsUpperBound: true, availableBytes: 6 * GB, poolBytes: 80 * GB,
    }));
    expect(v.headline).toContain('up to 4.0 GB for 32k context');
  });

  it('a text-only model gets no vision row in the line', () => {
    const v = checkMemoryForLoad(inputs({ modelBytes: 9 * GB, kvBytes: 4 * GB, availableBytes: 6 * GB, poolBytes: 80 * GB }));
    expect(v.headline).not.toMatch(/vision/);
  });

  it('BLOCKS a model past the pool AND the memory available', () => {
    const v = checkMemoryForLoad(inputs({ modelBytes: 200 * GB, availableBytes: 32 * GB, poolBytes: 80 * GB }));
    expect(v.verdict).toBe('too-large');
    expect(v.detail).toMatch(/smaller model|quant/i);
    expect(v.detail).toContain("Lower this model's context length");
  });

  it('warns when it needs more than is free right now — and does NOT subtract loaded twice', () => {
    // 10 GB needed, 8 GB free: the resident models are already excluded from
    // "available", so subtracting them again here would double-count them.
    const v = checkMemoryForLoad(inputs({
      modelBytes: 9 * GB, kvBytes: 0.5 * GB, loadedBytes: 20 * GB, availableBytes: 8 * GB, poolBytes: 80 * GB,
    }));
    expect(v.verdict).toBe('tight');
    expect(v.detail).toContain('8.0 GB this computer has free');
  });

  it('a dismissal silences the warning only at the SAME context length (§D4)', () => {
    const tight = inputs({
      modelBytes: 9 * GB, kvBytes: 0.5 * GB, contextLength: 32768, availableBytes: 8 * GB, poolBytes: 80 * GB,
    });
    expect(checkMemoryForLoad({ ...tight, dismissed: { contextLength: 32768 } }).verdict).toBe('ok');
    // The user raised the context — the model now needs more memory than what
    // they dismissed, so it asks again.
    expect(checkMemoryForLoad({ ...tight, dismissed: { contextLength: 8192 } }).verdict).toBe('tight');
    expect(checkMemoryForLoad({ ...tight, dismissed: null }).verdict).toBe('tight');
  });

  it('too-large is never dismissible', () => {
    const v = checkMemoryForLoad(inputs({
      modelBytes: 200 * GB, availableBytes: 32 * GB, poolBytes: 80 * GB, dismissed: { contextLength: 32768 },
    }));
    expect(v.verdict).toBe('too-large');
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

describe('the real models on this machine keep their verdicts', () => {
  // Read off ~/.cache/llama.cpp with the shipping reader on 2026-09-05, so a
  // refactor that changes any of the arithmetic above shows up as a number a
  // person can sanity-check rather than as a passing abstract test.
  const z13 = { poolBytes: 86016 * MIB, poolIsGpu: true, availableBytes: 70 * GB, loadedBytes: 0 };

  it('Qwen3.5-9B (32 layers, 24 recurrent, 4 KV heads, 256/256) — 0.8 GB of cache at 32k', () => {
    const h = header({
      blockCount: 32, headCountKv: 4, keyLength: 256, valueLength: 256,
      recurrentLayers: Array.from({ length: 32 }, (_, il) => (il + 1) % 4 !== 0),
    });
    const kv = kvCacheBytes(h, 32768, Q8K);
    expect(kv.bytes / GB).toBeCloseTo(0.80, 2);
    expect(estimateFit({ modelBytes: 8.87 * GB, kvBytes: kv.bytes, contextLength: 32768, ...z13 }).fit).toBe('fits');
  });

  it('gemma-4-E2B (35 layers, 20 shared, 512-token window, half-width sliding) — 0.16 GB at 32k', () => {
    // The real file's mask, read out of Destin's own copy: every 5th layer is
    // full attention, and only the first 15 layers store a cache of their own.
    const sliding = Array.from({ length: 35 }, (_, il) => (il + 1) % 5 !== 0);
    const h = header({
      blockCount: 35, headCountKv: 1, keyLength: 512, valueLength: 512,
      keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 512,
      slidingLayers: sliding, sharedKvLayers: 20,
    });
    const kv = kvCacheBytes(h, 32768, Q8K);
    expect(kv.bytes / GB).toBeCloseTo(0.16, 2);
    expect(estimateFit({ modelBytes: 4.7 * GB, kvBytes: kv.bytes, contextLength: 32768, ...z13 }).fit).toBe('fits');
  });

  it('Qwen3.8-Flash-Next (103.7 GB on disk) splits across the pool and memory — it is NOT blocked', () => {
    const h = header({
      blockCount: 48, headCountKv: 2, keyLength: 256, valueLength: 256,
      recurrentLayers: Array.from({ length: 48 }, (_, il) => (il + 1) % 4 !== 0),
    });
    const kv = kvCacheBytes(h, 32768, Q8K);
    const r = estimateFit({ modelBytes: 103.69 * GB, kvBytes: kv.bytes, contextLength: 32768, ...z13 });
    expect(r.fit).toBe('tight');
    expect(r.label).toMatch(/splits/i);
  });
});
