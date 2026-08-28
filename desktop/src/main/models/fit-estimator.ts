// Honest fit estimation (spec §4.3 + Amendment 2026-07-14 F): GPU-AWARE.
// llama.cpp offloads layers to VRAM, so a RAM-only estimate under-promises on
// discrete-GPU machines. Model of how memory is actually used:
//   - Will it RUN?  weights + KV must fit in VRAM + system RAM combined (a layer
//     lives in exactly one pool; CPU can run whatever the GPU can't hold).
//   - Will it run WELL?  how much fits in VRAM (all → fast; split → decent).
// SAFETY BIAS: VRAM only ever UPGRADES a verdict, and only when a real
// dedicated GPU's VRAM was confidently probed. totalVramBytes null/0 → the
// original RAM-only path, so we're never worse than before and never
// over-promise on an unconfirmed GPU. PURE: callers inject os.totalmem() and
// gpu-detector's totalVramBytes so tests pin every threshold.
import type { FitEstimate } from '../../shared/model-manager-types';

const GB = 1024 ** 3;
// Runtime overhead on top of the weights: KV cache at our default -c plus
// engine/OS headroom. Deliberately a blunt constant — precision here would be
// fake (spec: "No fake precision").
const OVERHEAD_BYTES = 2 * GB;

export function estimateFit(
  modelSizeBytes: number, totalMemBytes: number, totalVramBytes: number | null = null
): FitEstimate {
  const need = modelSizeBytes + OVERHEAD_BYTES;
  if (totalVramBytes != null && totalVramBytes > 0) {
    // Fits entirely in VRAM → fully offloaded → fast.
    if (need <= totalVramBytes * 0.9) {
      return { fit: 'fits', label: 'Runs fast — fits on your GPU' };
    }
    // Splits across GPU + system RAM → runs at decent speed.
    if (need <= totalVramBytes + totalMemBytes * 0.7) {
      return { fit: 'fits', label: 'Runs well — uses your GPU plus memory' };
    }
    if (need <= totalVramBytes + totalMemBytes * 0.9) {
      return { fit: 'tight', label: 'Will be tight — close other apps first' };
    }
    return { fit: 'too-large', label: 'Too large for this machine' };
  }
  // RAM-only path (no confident dedicated GPU).
  if (need <= totalMemBytes * 0.7) return { fit: 'fits', label: 'Should run well on this machine' };
  if (need <= totalMemBytes * 0.9) return { fit: 'tight', label: 'Will be tight — close other apps first' };
  return { fit: 'too-large', label: 'Too large for this machine' };
}

/** Create-time / swap-time memory guard (2026-07-14). Answers "is it safe to
 *  load THIS model given what's already resident?" Distinct from estimateFit,
 *  which asks "could this machine ever run it?". Decision (Destin): BLOCK only
 *  when clearly too large (won't fit even alone); otherwise WARN with a
 *  "show more" detail explaining LRU eviction + swap. PURE — caller injects
 *  os.totalmem(), gpu VRAM, and the summed footprint of loaded models. */
export interface MemoryVerdict {
  verdict: 'ok' | 'tight' | 'too-large';
  headline: string; // short warning row; '' when verdict === 'ok'
  detail: string;   // "show more" explanation; '' when verdict === 'ok'
}

export function checkMemoryForLoad(args: {
  chosenBytes: number;
  totalMemBytes: number;
  totalVramBytes: number | null;
  /** Σ sizeBytes of models already loaded/loading, EXCLUDING the chosen one. */
  loadedBytes: number;
}): MemoryVerdict {
  const { chosenBytes, totalMemBytes, totalVramBytes, loadedBytes } = args;
  // Unified-memory machines (APU/iGPU) report null VRAM (it IS system RAM), so
  // capacity is just totalMem — never double-counted. A dedicated GPU adds VRAM.
  const capacity = totalMemBytes + (totalVramBytes ?? 0);
  const g = (n: number) => (n / GB).toFixed(1);

  // BLOCK: clearly too large — can't fit even alone on a fresh machine.
  if (estimateFit(chosenBytes, totalMemBytes, totalVramBytes).fit === 'too-large') {
    return {
      verdict: 'too-large',
      headline: 'This model is too large for this computer.',
      detail:
        `${g(chosenBytes)} GB (plus working memory) is more than the ${g(capacity)} GB this ` +
        `computer can hold, even on its own. It would fail to load or run extremely slowly. ` +
        `Try a smaller model or a more compressed version (a lower "quant").`,
    };
  }

  // WARN: fits alone, but adding it to what's already loaded over-commits memory.
  const combined = chosenBytes + loadedBytes + OVERHEAD_BYTES;
  if (loadedBytes > 0 && combined > capacity * 0.85) {
    return {
      verdict: 'tight',
      headline: 'This may use more memory than you have free.',
      detail:
        `You currently have about ${g(loadedBytes)} GB of models loaded. Adding this ` +
        `${g(chosenBytes)} GB model can push past your ${g(capacity)} GB of memory. ` +
        `YouCoded keeps at most 2 models in memory at once, so an older model will be ` +
        `unloaded to make room. If things still don't fit, your computer falls back to ` +
        `slower disk-backed memory (swap) and replies get slower. You can still continue.`,
    };
  }

  return { verdict: 'ok', headline: '', detail: '' };
}

/** Pre-download disk guard (spec §4.3). Returns null when OK, else a
 *  plain-language refusal. 5% margin covers the in-flight .partial file.
 *  `alreadyOnDiskBytes` is what a resume has already fetched — charging the
 *  FULL size against a resume tells the user "not enough space" for something
 *  that fits, and the obvious reaction is to delete the partial, destroying
 *  the very thing that made it fit (2026-08-26). */
export function checkDiskSpace(downloadBytes: number, freeBytes: number, alreadyOnDiskBytes = 0): string | null {
  const needBytes = Math.max(0, downloadBytes - alreadyOnDiskBytes);
  if (freeBytes >= needBytes * 1.05) return null;
  const needGb = (needBytes / GB).toFixed(1);
  const freeGb = (freeBytes / GB).toFixed(1);
  return `Not enough free space: this download needs about ${needGb} GB but only ${freeGb} GB is free.`;
}
