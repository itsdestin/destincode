import React from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { OLLAMA_MODEL_CATALOG, MODEL_DETAILS, hasVision } from './model-catalog';

// ── (i) info popup ───────────────────────────────────────────────────────
// Detailed reference card for a single catalog model. Opened by the ⓘ icon
// on a Local Models catalog row. Centered Layer-2 overlay, matching the
// ModelPickerPopup treatment.

interface ModelInfoPopupProps {
  /** Catalog model id (MODEL_DETAILS key). Null/absent = closed. */
  modelName: string | null;
  onClose: () => void;
}

/** A label/value row in the popup's spec grid. */
function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</span>
      <span className="text-xs text-fg">{value}</span>
    </div>
  );
}

export function ModelInfoPopup({ modelName, onClose }: ModelInfoPopupProps) {
  const open = !!modelName;
  useEscClose(open, onClose);
  if (!modelName) return null;

  const d = MODEL_DETAILS[modelName];
  // Defensive: a catalog entry with no details record. The model-catalog
  // sanity test guards against this, but render a minimal card rather than
  // crashing if the data ever drifts.
  if (!d) {
    return createPortal(
      <>
        <Scrim layer={2} onClick={onClose} />
        <OverlayPanel
          layer={2}
          role="dialog"
          aria-modal={true}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-80"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-4 text-sm text-fg-muted">
            No detailed information available for <span className="font-mono text-fg">{modelName}</span>.
          </div>
        </OverlayPanel>
      </>,
      document.body,
    );
  }

  const modalityLabel = d.modalities
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1))
    .join(', ');

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[28rem] max-w-[calc(100%-2rem)] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-4 py-3 border-b border-edge">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg font-mono truncate">{modelName}</h3>
            <div className="text-[11px] text-fg-muted mt-0.5">
              {d.developer} · {d.parameters} · {d.license}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg transition-colors w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset shrink-0"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {/* Description */}
          <p className="text-xs text-fg-2 leading-relaxed">{d.description}</p>

          {/* Spec grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 py-2 border-y border-edge-dim">
            <SpecRow label="Released" value={d.released} />
            <SpecRow label="Context" value={d.contextWindow} />
            <SpecRow label="Modalities" value={modalityLabel} />
            <SpecRow label="Thinking" value={d.thinking} />
            <SpecRow label="Tool use" value={d.toolUse} />
          </div>

          {/* Strengths */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Strengths</div>
            <ul className="space-y-0.5">
              {d.strengths.map((s, i) => (
                <li key={i} className="text-xs text-fg-2 flex gap-1.5">
                  <span className="text-fg-muted shrink-0">+</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Weaknesses */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Weaknesses</div>
            <ul className="space-y-0.5">
              {d.weaknesses.map((w, i) => (
                <li key={i} className="text-xs text-fg-2 flex gap-1.5">
                  <span className="text-fg-muted shrink-0">−</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Best for + Hardware */}
          <div className="space-y-1.5 pt-1">
            <div className="flex gap-2 text-xs">
              <span className="text-fg-muted shrink-0 w-16">Best for</span>
              <span className="text-fg-2">{d.bestFor}</span>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="text-fg-muted shrink-0 w-16">Hardware</span>
              <span className="text-fg-2">{d.hardware}</span>
            </div>
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}

// ── Compare tab ──────────────────────────────────────────────────────────
// Side-by-side table of every catalog model. Rendered inside the Local
// Models popup's "Compare" tab. Static (not sortable) — six rows doesn't
// justify sort controls. Same data source as the (i) popup.

interface ModelCompareTabProps {
  /** Ids of currently-installed models — installed rows get an "Installed" mark. */
  installedNames: string[];
  /** Opens the (i) popup for a model — clicking a row name drills in. */
  onShowDetails: (modelName: string) => void;
}

export function ModelCompareTab({ installedNames, onShowDetails }: ModelCompareTabProps) {
  const installed = new Set(installedNames);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-fg-muted text-left">
            <th className="font-medium py-1.5 pr-2">Model</th>
            <th className="font-medium py-1.5 px-2">Size</th>
            <th className="font-medium py-1.5 px-2">Context</th>
            <th className="font-medium py-1.5 px-2">Thinking</th>
            <th className="font-medium py-1.5 px-2">Tools</th>
            <th className="font-medium py-1.5 px-2">Vision</th>
            <th className="font-medium py-1.5 pl-2">License</th>
          </tr>
        </thead>
        <tbody>
          {OLLAMA_MODEL_CATALOG.map((entry) => {
            const d = MODEL_DETAILS[entry.name];
            if (!d) return null;
            return (
              <tr key={entry.name} className="border-t border-edge-dim">
                <td className="py-1.5 pr-2">
                  <button
                    onClick={() => onShowDetails(entry.name)}
                    className="font-mono text-fg hover:text-accent transition-colors text-left flex items-center gap-1"
                    title="Show model details"
                  >
                    {entry.name}
                    {entry.warning && (
                      <span className="text-yellow-600" title={entry.warning}>⚠</span>
                    )}
                  </button>
                  {installed.has(entry.name) && (
                    <span className="ml-1 text-[9px] text-green-500">●</span>
                  )}
                </td>
                <td className="py-1.5 px-2 text-fg-2 whitespace-nowrap">{entry.sizeLabel}</td>
                <td className="py-1.5 px-2 text-fg-2 whitespace-nowrap">{d.contextWindow.replace(' tokens', '')}</td>
                <td className="py-1.5 px-2 text-fg-2 whitespace-nowrap">{d.thinking}</td>
                <td className="py-1.5 px-2 text-fg-2">{d.toolUse}</td>
                <td className="py-1.5 px-2 text-fg-2">{hasVision(d) ? 'Yes' : 'No'}</td>
                <td className="py-1.5 pl-2 text-fg-2 whitespace-nowrap">{d.license}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 text-[10px] text-fg-muted">
        <span className="text-green-500">●</span> installed ·{' '}
        <span className="text-yellow-600">⚠</span> known issues — click a model name for details.
      </div>
    </div>
  );
}
