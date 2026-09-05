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
  /** Only reason to change it: the ✕ sits on an accent fill, not a panel
   *  ("on-accent"). Passing a className instead does NOT work — ghost's own
   *  hover classes still ship, and two competing hover backgrounds resolve by
   *  Tailwind's source order rather than by what the caller wrote. */
  variant?: ButtonVariant;
};

export const CloseButton = React.forwardRef<HTMLButtonElement, CloseButtonProps>(
  function CloseButton({ label, variant = 'ghost', ...rest }, ref) {
    return (
      <Button ref={ref} size="icon" variant={variant} aria-label={label ?? 'Close'} {...rest}>
        <svg
          className="w-4 h-4"
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
