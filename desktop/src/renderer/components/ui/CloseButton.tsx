import React from 'react';
import { Button, type ButtonVariant } from './Button';

/**
 * The popup ✕ (change 41, §1.8).
 *
 * The same `w-7 h-7 rounded-sm hover:bg-inset` + copy-pasted SVG was duplicated
 * across at least 8 files (AccountSection, ModelPickerPopup x2, PreferencesPopup,
 * AboutPopup, ModelProvidersPopup x2, ContextPopup, PerformancePopup). This is
 * that button, once, on the approved Button icon+ghost recipe.
 *
 * Documented exception: the terminal scroll buttons keep w-10 h-10 via className.
 */

export type CloseButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> & {
  /** Override when "Close" is ambiguous — e.g. "Close settings", "Dismiss toast". */
  label?: string;
  /** 'icon-sm' on a chip-height bar, where the default 28px square would set the
   *  bar's own height. The glyph shrinks with it. */
  size?: 'icon' | 'icon-sm';
  /** Only reason to change it: the ✕ sits on an accent fill, not a panel
   *  ("on-accent"). Passing a className instead does NOT work — ghost's own
   *  hover classes still ship, and two competing hover backgrounds resolve by
   *  Tailwind's source order rather than by what the caller wrote. */
  variant?: ButtonVariant;
};

export const CloseButton = React.forwardRef<HTMLButtonElement, CloseButtonProps>(
  function CloseButton({ label, variant = 'ghost', size = 'icon', ...rest }, ref) {
    return (
      <Button ref={ref} size={size} variant={variant} aria-label={label ?? 'Close'} {...rest}>
        <svg
          // 12px in a 20px box leaves 4px of padding all round, which is what
          // turns the hover fill into a container AROUND the glyph.
          className={size === 'icon-sm' ? 'w-3 h-3' : 'w-4 h-4'}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </Button>
    );
  },
);
