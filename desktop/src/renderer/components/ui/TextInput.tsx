import React from 'react';
import { fieldClasses, type FieldSize } from './field';

/**
 * Text entry on the shared FIELD surface (§1.3).
 *
 * Deliberately NOT restricted to type="text" — password, search, and number all
 * route through here and keep their native type. The only text-entry element
 * that stays hand-rolled is the chat composer (InputBar), which is a transparent
 * textarea over a mirror overlay and is sui generis.
 */

export type TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  /** md (default) for forms; sm for inline row actions and filter bars. */
  size?: FieldSize;
};

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { size = 'md', className = '', type = 'text', ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={fieldClasses(size, className)} {...rest} />;
});

export default TextInput;
