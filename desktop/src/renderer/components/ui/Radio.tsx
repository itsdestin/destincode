import React from 'react';
import { FOCUS_RING } from './Button';

/**
 * Option lists (§1.4, change 39). Replaces the native radios at
 * PreferencesPopup's permission-mode list and SyncSetupWizard's two groups.
 *
 * Use RadioGroup rather than bare Radios — a radio group is ONE tab stop with
 * arrow-key navigation between options, which is what screen-reader and
 * keyboard users expect and what native radios gave us for free. Bare Radios
 * would make every option its own tab stop.
 */

export type RadioProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onChange: () => void;
};

export const Radio = React.forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { checked, onChange, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={
        'inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded-full transition-colors coarse-hit ' +
        'disabled:opacity-50 disabled:cursor-not-allowed ' +
        FOCUS_RING +
        ' ' +
        (checked ? 'bg-inset border border-accent' : 'bg-inset border border-edge-dim') +
        ' ' +
        className
      }
      {...rest}
    >
      {checked && <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden="true" />}
    </button>
  );
});

export type RadioGroupProps = {
  /** Stable option ids in visual order — arrow keys walk this list. */
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * Wraps a set of Radios as one roving-focus group.
 *
 * Arrow keys move selection and wrap at the ends, matching native radio
 * behavior. Only the selected Radio is tabbable (roving tabindex), so Tab
 * enters and leaves the whole group in one stop.
 */
export function RadioGroup({
  options,
  value,
  onChange,
  className = '',
  children,
  ...aria
}: RadioGroupProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Don't hijack arrow keys typed into a nested editable field. An option's
    // body can contain its own inputs (e.g. SyncSetupWizard's repo-name inputs
    // sit inside the radio rows); without this, arrows there would bubble here
    // and switch the selection. Native radios never do that. Keydowns from a
    // radio or the group itself still navigate.
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1
      : 0;
    if (delta === 0) return;
    e.preventDefault();
    const i = options.indexOf(value);
    if (i === -1) return;
    // Wrap, like native radios.
    onChange(options[(i + delta + options.length) % options.length]);
  };

  return (
    <div role="radiogroup" className={className} onKeyDown={onKeyDown} {...aria}>
      {children}
    </div>
  );
}
