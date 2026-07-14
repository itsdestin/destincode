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

/** Pre-download disk guard (spec §4.3). Returns null when OK, else a
 *  plain-language refusal. 5% margin covers the in-flight .partial file. */
export function checkDiskSpace(downloadBytes: number, freeBytes: number): string | null {
  if (freeBytes >= downloadBytes * 1.05) return null;
  const needGb = (downloadBytes / GB).toFixed(1);
  const freeGb = (freeBytes / GB).toFixed(1);
  return `Not enough free space: this download needs about ${needGb} GB but only ${freeGb} GB is free.`;
}
