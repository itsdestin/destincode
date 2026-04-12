import React from 'react';

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

// Fix: Chrome's backdrop-filter doesn't sample correctly when applied to an
// element that also carries a transform (e.g., `translate(-50%, -50%)` for
// centered modals). The same workaround that landed for `.settings-drawer`
// in 83ce87ca applies to every OverlayPanel consumer that uses centering
// transforms. Split into:
//   - Outer wrapper: positioning, sizing, layout, overflow, any caller
//     transforms (all flowing through `className` and `style`).
//   - Inner `.layer-surface`: absolutely-positioned sibling sandwiched
//     *behind* the caller's children (z-index:0). It owns the glass
//     treatment — backdrop-filter, border, border-radius, box-shadow,
//     background-color — on an untransformed element so Chrome samples
//     the backdrop correctly.
// The inner is aria-hidden and non-interactive so it doesn't affect the
// semantic tree or click handling. Caller children remain direct flex/grid
// participants of the outer wrapper — no layout regressions.
// The outer keeps caller-provided positioning/sizing/layout/overflow
// classes. `.layer-surface` stays on the outer for border, border-radius,
// shadow, and background-color — these are NOT affected by transforms.
// The inner `.layer-surface-blur` sibling is the ONE piece the transform
// bug affects: backdrop-filter. By hosting it on an absolutely-positioned,
// untransformed child, Chrome samples the backdrop correctly even when
// the outer carries a centering `translate(-50%, -50%)` or slide transform.
// The inner is pointer-events:none and aria-hidden; children paint on top
// via normal flow (positioned ancestor is the outer, so z-index:0 sits
// beneath normal children without needing explicit stacking). See 83ce87ca
// for the original per-component proof of this pattern.
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
      <div
        aria-hidden="true"
        className="layer-surface-blur pointer-events-none"
        style={{ position: 'absolute', inset: 0, zIndex: 0, borderRadius: 'inherit' }}
      />
      {children}
    </div>
  ),
);
OverlayPanel.displayName = 'OverlayPanel';
