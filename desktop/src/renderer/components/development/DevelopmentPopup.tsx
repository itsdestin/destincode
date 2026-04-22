// desktop/src/renderer/components/development/DevelopmentPopup.tsx
// L2 popup with three rows: Report, Contribute, Known Issues.
// Reuses the existing layer-scrim + layer-surface tokens so the popup
// picks up the active theme automatically — no hardcoded colors or z-indexes.
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenBug: () => void;
  onOpenContribute: () => void;
}

const KNOWN_ISSUES_URL = 'https://github.com/itsdestin/youcoded/issues';

/**
 * L2 popup with three rows: Report, Contribute, Known Issues. Reuses
 * the existing layer-scrim + layer-surface tokens so the popup picks
 * up the active theme automatically.
 */
export function DevelopmentPopup({ open, onClose, onOpenBug, onOpenContribute }: Props) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 layer-scrim" data-layer="2" />
      <div
        className="layer-surface relative p-4 w-[320px] mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Development</h3>
        <div className="space-y-2">
          <Row
            icon="🐞"
            title="Report a Bug or Request a Feature"
            subtitle="Send it to the maintainers"
            onClick={() => { onOpenBug(); }}
          />
          <Row
            icon="🤝"
            title="Contribute to YouCoded"
            subtitle="Set up the dev workspace"
            onClick={() => { onOpenContribute(); }}
          />
          <Row
            icon="📋"
            title="Known Issues and Planned Features"
            subtitle="Browse open issues on GitHub"
            onClick={() => { window.open(KNOWN_ISSUES_URL, '_blank'); onClose(); }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ icon, title, subtitle, onClick }: { icon: string; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
    >
      <div className="flex items-center justify-center shrink-0 text-base" style={{ width: 32, height: 20 }}>{icon}</div>
      <div className="flex-1 min-w-0">
        <span className="text-xs text-fg font-medium">{title}</span>
        <p className="text-[10px] text-fg-muted">{subtitle}</p>
      </div>
      <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
