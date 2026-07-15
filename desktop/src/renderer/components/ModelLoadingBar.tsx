import React, { useEffect, useState } from 'react';
import type { EngineModelState } from '../../shared/engine-types';

// Centered status strip that floats just ABOVE the input area for a NATIVE
// (local-model) session. Two states (2026-07-14 memory-lifecycle UX):
//   • LOADING  — the model is (re)loading into RAM. When main can measure the
//     model child's resident bytes, shows a DETERMINATE bar + "N GB / M GB"
//     (Unsloth-Studio style); otherwise an indeterminate bar + elapsed seconds.
//   • UNLOADED — the model slept to save memory and no turn is in flight:
//     "Model unloaded to save memory · [Reload Model]".
// Renders nothing when the model is loaded (or state unknown). Positioned by the
// caller in ChatView's outer absolute container so it isn't clipped by chat-pane.

interface Props {
  modelState: EngineModelState | null;
  modelInfo: { modelId: string; sizeBytes: number | null } | null;
  /** Bytes resident so far while loading (null when unavailable / not loading). */
  loadedBytes: number | null;
  isThinking: boolean;
  onReload: (modelId: string) => void;
}

/** Trim a GGUF id to something human: drop the split suffix + quant tag. */
function friendlyName(modelId: string): string {
  return modelId
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .replace(/-(UD-)?[QIF]\d[^-]*(_[A-Z0-9]+)*$/i, '')
    .replace(/-(UD-)?(BF16|F16|F32|MXFP4(_MOE)?)$/i, '');
}

function gbNum(bytes: number | null | undefined): string {
  return ((bytes ?? 0) / 1024 ** 3).toFixed(1);
}

export default function ModelLoadingBar({ modelState, modelInfo, loadedBytes, isThinking, onReload }: Props) {
  // The model is coming up if it's explicitly loading, OR a turn is in flight
  // while the model is still asleep/unloaded (the send is waking it).
  const notResident = modelState === 'sleeping' || modelState === 'unloaded';
  const loading = modelState === 'loading' || (isThinking && notResident);
  const showReload = !isThinking && notResident;

  // Elapsed-seconds ticker (fallback signal when byte-progress isn't available).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading, modelInfo?.modelId]);

  if (!modelInfo || (!loading && !showReload)) return null;

  const name = friendlyName(modelInfo.modelId);
  const size = modelInfo.sizeBytes;
  // Determinate GB progress when we have both resident bytes and a total size.
  const hasProgress = loading && loadedBytes != null && loadedBytes > 0 && size != null && size > 0;
  const pct = hasProgress ? Math.min(100, Math.round((loadedBytes! / size!) * 100)) : 0;

  return (
    <div className="model-status-strip absolute left-1/2 -translate-x-1/2 z-10 w-[min(88%,26rem)]">
      <div className="layer-surface rounded-xl px-4 py-3 shadow-lg">
        {loading ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-center gap-1.5 text-sm text-fg-2">
              <span className="italic">Loading</span>
              <span className="font-medium">{name}</span>
              {hasProgress ? (
                <span className="text-fg-dim text-xs tabular-nums">
                  · {gbNum(loadedBytes)} / {gbNum(size)} GB
                </span>
              ) : size != null ? (
                <span className="text-fg-dim text-xs">· {gbNum(size)} GB · {elapsed}s</span>
              ) : (
                <span className="text-fg-faint text-xs tabular-nums">· {elapsed}s</span>
              )}
            </div>
            {hasProgress ? (
              // Determinate: fill tracks resident bytes / total size.
              <div className="h-1.5 rounded-full bg-well overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : (
              // Indeterminate: no byte measurement (non-Linux / racing) — sweep.
              <div className="model-load-track h-1.5 rounded-full bg-well" />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <span className="text-sm text-fg-muted">Model unloaded to save memory.</span>
            <button
              type="button"
              onClick={() => onReload(modelInfo.modelId)}
              className="text-xs font-medium px-3 py-1 rounded-full bg-accent text-on-accent hover:opacity-90 shrink-0"
            >
              Reload model
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
