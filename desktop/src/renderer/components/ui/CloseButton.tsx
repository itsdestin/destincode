import React from 'react';
import { Button } from './Button';

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
};

export const CloseButton = React.forwardRef<HTMLButtonElement, CloseButtonProps>(
  function CloseButton({ label, ...rest }, ref) {
    return (
      <Button ref={ref} size="icon" variant="ghost" aria-label={label ?? 'Close'} {...rest}>
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
