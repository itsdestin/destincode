import React, { useEffect, useState } from 'react';
import type { EngineModelState } from '../../shared/engine-types';
import BrailleSpinner from './BrailleSpinner';

// Per-session banner for a NATIVE (local-model) session, mounted at the top of
// the chat timeline. Two jobs (2026-07-14 memory-lifecycle feature):
//   #4  model was unloaded/slept to save memory → offer [Reload Model].
//   #5  model is (re)loading → show its size + a spinner + elapsed time.
// Renders nothing when the model is 'loaded' or state is unknown (null).

interface Props {
  modelState: EngineModelState | null;
  modelInfo: { modelId: string; sizeBytes: number | null } | null;
  /** Called by [Reload Model] — wired to window.claude.models.load(modelId). */
  onReload: (modelId: string) => void;
}

/** Trim a GGUF id to something human: drop the split suffix + quant tag. */
function friendlyName(modelId: string): string {
  return modelId
    .replace(/-\d{5}-of-\d{5}$/i, '')                 // multi-part suffix
    .replace(/-(UD-)?[QIF]\d[^-]*(_[A-Z0-9]+)*$/i, '') // trailing quant (best-effort)
    .replace(/-(UD-)?(BF16|F16|F32|MXFP4(_MOE)?)$/i, '');
}

function gb(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  return (bytes / 1024 ** 3).toFixed(1) + ' GB';
}

export default function ModelStateBanner({ modelState, modelInfo, onReload }: Props) {
  const loading = modelState === 'loading';
  // Elapsed-seconds ticker, only while loading (cold loads of big models are slow
  // and llama-server exposes no % — elapsed time is the honest progress signal).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading, modelInfo?.modelId]);

  if (!modelInfo) return null;
  if (modelState !== 'sleeping' && modelState !== 'unloaded' && modelState !== 'loading') {
    return null; // 'loaded' or unknown → nothing to show
  }

  const name = friendlyName(modelInfo.modelId);
  const size = gb(modelInfo.sizeBytes);

  return (
    <div className="flex flex-col items-start gap-1 px-4 py-2 in-view">
      <div className="flex items-center gap-2 bg-inset rounded-2xl px-4 py-2.5 max-w-full">
        {loading ? (
          <>
            <BrailleSpinner size="base" />
            <span className="text-sm text-fg-muted">
              Loading <span className="text-fg-2">{name}</span>
              {size ? <span className="text-fg-dim"> · {size}</span> : null}
              <span className="text-fg-faint"> · {elapsed}s</span>
            </span>
          </>
        ) : (
          <>
            <span className="text-sm text-fg-muted">
              Model unloaded to save memory.
            </span>
            <button
              type="button"
              onClick={() => onReload(modelInfo.modelId)}
              className="text-xs font-medium px-2.5 py-1 rounded-full bg-accent text-on-accent hover:opacity-90 shrink-0"
            >
              Reload model
            </button>
          </>
        )}
      </div>
    </div>
  );
}
