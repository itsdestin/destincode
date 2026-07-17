import React from 'react';
import { FOCUS_RING } from './Button';

/**
 * Consent checkbox (§1.4).
 *
 * Narrow by design: Toggle owns settings/state, chips own filters, Radio owns
 * option lists (design rule 8). After the migration this has essentially one
 * call site — ProjectView's delete-consent checkbox — plus whatever future
 * consent gates appear.
 */

export type CheckboxProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onChange: (next: boolean) => void;
};

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { checked, onChange, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      // 14px is well under the ~44dp touch guideline and this renderer is also
      // the Android UI, so coarse-hit expands the tap target on touch only.
      className={
        'inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 transition-colors coarse-hit ' +
        'disabled:opacity-50 disabled:cursor-not-allowed ' +
        FOCUS_RING +
        ' ' +
        (checked ? 'bg-accent border border-accent' : 'bg-inset border border-edge-dim') +
        ' ' +
        className
      }
      // Literal 4px, deliberately NOT rounded-sm. Radii are theme tokens, and on a
      // big-radius pack (--radius-sm up to 24px) a 14px box would render as a
      // circle — i.e. indistinguishable from a Radio. The shape carries meaning
      // here, so it can't be themeable.
      style={{ borderRadius: 4 }}
      {...rest}
    >
      {checked && (
        <svg
          className="w-full h-full text-on-accent"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4 10-11" />
        </svg>
      )}
    </button>
  );
});

export default Checkbox;
