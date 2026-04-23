import React from 'react';
import { useTerminalOverlayBlock } from '../../state/terminal-overlay-context';

// Phase 3 overlay primitives. Wrap .layer-scrim and .layer-surface from
// globals.css so components get consistent scrim color, blur, rounding,
// shadow, and z-index straight from the theme tokens.
//
// Layer semantics (see docs/plans/overlay-layer-system):
//   L1 Drawer   — side/bottom panels (Settings, CommandDrawer, ResumeBrowser)
//   L2 Popup    — anchored/centered panels (theme picker, ShareSheet, pickers)
//   L3 Critical — destructive confirmations (delete session, clear history)
//   L4 System   — always-visible indicators (toasts, keyboard shortcut hint)

export type OverlayLayer = 1 | 2 | 3 | 4;

const SCRIM_Z: Record<OverlayLayer, number> = { 1: 40, 2: 60, 3: 70, 4: 100 };
const CONTENT_Z: Record<OverlayLayer, number> = { 1: 50, 2: 61, 3: 71, 4: 100 };

type ScrimProps = {
  layer: OverlayLayer;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export function Scrim({ layer, onClick, className = '', style, children }: ScrimProps) {
  // Tell the Android PassThroughWebView to stop passing touches through to the
  // native terminal while this scrim is mounted — otherwise a tap on a modal
  // button over the terminal would fall through to the terminal below.
  useTerminalOverlayBlock();
  return (
    <div
      className={`layer-scrim ${className}`.trim()}
      data-layer={layer}
      style={{ zIndex: SCRIM_Z[layer], ...style }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

type OverlayPanelProps = {
  layer: OverlayLayer;
  destructive?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
  role?: string;
  'aria-modal'?: boolean;
  'aria-labelledby'?: string;
};

// Single-element .layer-surface. An earlier split added an inner
// .layer-surface-blur absolutely-positioned child to host backdrop-filter
// on an untransformed element (so Chrome could sample the backdrop through
// centering transforms on the outer). That child stacked above non-positioned
// caller children per CSS painting order (positioned z-index:0 paints above
// non-positioned block descendants) and made every OverlayPanel consumer
// appear blank. Backdrop-filter under a centering transform only matters
// when a wallpaper is active; solve that per-component if/when a specific
// popup needs it, instead of breaking the shared primitive.
export const OverlayPanel = React.forwardRef<HTMLDivElement, OverlayPanelProps>(
  ({ layer, destructive, className = '', style, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={`layer-surface ${className}`.trim()}
      data-layer={layer}
      data-destructive={destructive ? '' : undefined}
      style={{ zIndex: CONTENT_Z[layer], ...style }}
      {...rest}
    >
      {children}
    </div>
  ),
);
OverlayPanel.displayName = 'OverlayPanel';
