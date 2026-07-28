import React from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { Button } from './ui';

const DONATE_URL = 'https://buymeacoffee.com/itsdestin';

/**
 * "Okay to open donation link?" confirmation (change 30).
 *
 * This existed as two BYTE-IDENTICAL 41-line blocks in SettingsPanel.tsx — one in
 * AndroidSettings, one in DesktopSettings. Both were live; the duplication came
 * from the platform split, not from dead code. Converting each in place would
 * have left two copies of the converted thing, so it is one component now.
 *
 * L3, not the old hardcoded z-[9999]. It is a confirmation gate, which is what L3
 * is for, and 9999 was only ever reaching over the 9000 host band — nothing in
 * that band can be open while a settings sub-modal is up.
 */
export function DonateConfirm({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return createPortal(
    <>
      <Scrim layer={3} onClick={onClose} />
      <OverlayPanel
        layer={3}
        role="dialog"
        aria-modal={true}
        aria-label="Confirm opening the donation link"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-6 max-w-xs w-[calc(100%-2rem)] text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs text-fg-muted mb-1">Donations supported via</p>
        <div className="flex items-center justify-center gap-2 mb-5">
          {/* Custom coffee-mug icon: body + handle + rising steam. Ties to "Buy Me a Coffee" label via BMC yellow. */}
          <svg className="w-5 h-5 text-[#FFDD00]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 2v2M11 2v2M15 2v2" />
            <path d="M3 8h14v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z" />
            <path d="M17 11h2a2.5 2.5 0 0 1 0 5h-2" />
          </svg>
          <span className="text-sm font-bold text-fg">Buy Me a Coffee</span>
        </div>
        <p className="text-2xs text-fg-dim mb-5">Okay to open donation link?</p>
        <div className="flex gap-2">
          {/* py-2.5 kept as a deliberate override: this two-button footer is
              the whole modal, so md's py-1.5 reads too slight here. */}
          <Button variant="secondary" onClick={onClose} className="flex-1 py-2.5">
            Cancel
          </Button>
          {/* Change 52: hover:brightness-110 was invisible on Light/Creme's
              near-black accent and blew out the glow packs. */}
          <Button
            onClick={() => {
              window.open(DONATE_URL, '_blank');
              onClose();
            }}
            className="flex-1 py-2.5"
          >
            Open
          </Button>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}
