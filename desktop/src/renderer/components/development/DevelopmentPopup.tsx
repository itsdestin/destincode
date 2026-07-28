// desktop/src/renderer/components/development/DevelopmentPopup.tsx
// L2 popup with three rows: Report, Contribute, Known Issues.
// Uses the shared <Dialog> shell so the popup
// picks up theme tokens automatically — no hardcoded colors, blur, or z-indexes
// (PITFALLS overlay invariant).
import { createPortal } from 'react-dom';
import { Dialog, SettingRow } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenBug: () => void;
  onOpenContribute: () => void;
}

const KNOWN_ISSUES_URL = 'https://github.com/itsdestin/youcoded/issues';

/**
 * L2 popup with three rows: Report, Contribute, Known Issues. Uses
 * shared <Dialog> shell so the popup picks up the active
 * theme automatically via CSS tokens.
 */
export function DevelopmentPopup({ open, onClose, onOpenBug, onOpenContribute }: Props) {
  useEscClose(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      <Dialog open onClose={onClose} size="prompt" aria-label="Development" scrollBody={false} className="p-4">
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Development</h3>
        {/* K2: these are nav rows — each one opens something — so they take the
            nav density (text-sm/text-2xs) rather than the smaller in-menu size
            they used to hand-roll. A row that navigates now looks the same here
            as it does in the settings drawer, which is the whole point. */}
        <div className="space-y-2">
          <SettingRow
            icon={<BugIcon />}
            title="Report a Bug or Request a Feature"
            description="Send it to the maintainers"
            onClick={() => { onOpenBug(); }}
          />
          <SettingRow
            icon={<CodeBracketsIcon />}
            title="Contribute to YouCoded"
            description="Set up the dev workspace"
            onClick={() => { onOpenContribute(); }}
          />
          <SettingRow
            icon={<ClipboardListIcon />}
            title="Known Issues and Planned Features"
            description="Browse open issues on GitHub"
            onClick={() => { window.open(KNOWN_ISSUES_URL, '_blank'); onClose(); }}
          />
        </div>
      </Dialog>
    </>,
    document.body,
  );
}

// Inline SVG icons matching the Other-section row style (stroke 1.8, currentColor → text-fg-muted).
// Each viewBox is 24×24, rendered at 16×16. All paths use round line caps and joins for a soft look.

function BugIcon() {
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {/* Body — pill-shaped, with the head merged into the rounded top */}
      <path d="M8 8 a4 4 0 0 1 8 0 v8 a4 4 0 0 1 -8 0 z" />
      {/* Antennae */}
      <path d="M9 7 L7 4" />
      <path d="M15 7 L17 4" />
      {/* Side legs (3 per side) */}
      <path d="M8 11 L5 11" />
      <path d="M8 14 L4 15" />
      <path d="M8 17 L5 19" />
      <path d="M16 11 L19 11" />
      <path d="M16 14 L20 15" />
      <path d="M16 17 L19 19" />
    </svg>
  );
}

function CodeBracketsIcon() {
  // </> — the iconic developer "code" symbol. Ties to "contribute to a codebase".
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 7 L4 12 L9 17" />
      <path d="M15 7 L20 12 L15 17" />
      <path d="M14 5 L10 19" />
    </svg>
  );
}

function ClipboardListIcon() {
  // Clipboard with three list lines — reads as "issue tracker / list of items".
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {/* Body with cutout at top where the clip sits */}
      <path d="M9 5 H7 a2 2 0 0 0 -2 2 v12 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-12 a2 2 0 0 0 -2 -2 h-2" />
      {/* Clip top */}
      <rect x="9" y="3" width="6" height="4" rx="1" />
      {/* List lines */}
      <path d="M9 12 H15" />
      <path d="M9 15 H15" />
      <path d="M9 18 H13" />
    </svg>
  );
}
