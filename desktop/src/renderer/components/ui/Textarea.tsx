import React from 'react';
import { fieldClasses, type FieldSize } from './field';

/**
 * Multi-line entry on the shared FIELD surface (§1.3, change 42).
 *
 * The 12 textareas across 11 files split across at least two conflicting
 * recipes — e.g. ContextPopup's `border-edge rounded-sm focus:ring-1` vs
 * BugReportPopup's `border-edge-dim rounded-lg focus:border-accent`. This is the
 * second one, which is FIELD.
 *
 * Excluded on purpose: the chat composer textarea (InputBar) — transparent text
 * over a mirror overlay, its own species.
 */

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  size?: FieldSize;
  /** Escape hatch for the rare textarea that should be user-resizable.
   *  Default off: drag-resize inside popups fights the popup's own layout. */
  resizable?: boolean;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { size = 'md', className = '', resizable = false, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={fieldClasses(size, `${resizable ? '' : 'resize-none'} ${className}`.trim())}
      {...rest}
    />
  );
});

export default Textarea;
