import React from 'react';
import { FIELD_SURFACE, FIELD_TEXT, FIELD_SIZE, type FieldSize } from './field';

/**
 * A field with its action INSIDE it (change 77, spec §11.9).
 *
 * Destin, deciding this: "for all text fields that have a submit/copy, I like the
 * button to be inside the field instead of alongside it."
 *
 * Why this can't just be a `className` on TextInput
 * -------------------------------------------------
 * The plain FIELD puts the border AND `focus:border-accent` on the <input>. Here
 * the border moves to a wrapper and the input goes bare — so if the focus rule
 * stayed on the input there would be no visible focus state at all (a borderless
 * element has no border to recolor). The wrapper takes `focus-within:border-accent`
 * instead. That's a structural difference, not a styling one, which is why this is
 * its own primitive rather than a variant.
 *
 * The pattern was already in the app before this primitive existed —
 * MarketplaceFilterBar's search box is exactly this shape. We standardized on it
 * rather than inventing a new one.
 *
 * Usage
 * -----
 *   <InputGroup size="md">
 *     <InputGroup.Field value={name} onChange={...} placeholder="Display name" />
 *     <Button size="sm" onClick={save}>Save</Button>
 *   </InputGroup>
 *
 * Sub-rule (spec §11.9): when a field has both a submit AND a Cancel, only the
 * SUBMIT goes inside. Cancel is not a field action, and two buttons inside stop
 * the thing reading as a field at all.
 *
 * NOT for: modal footers where the button sits below the field (~19 sites match
 * an `<input>`-near-`<button>` grep but are this shape — don't sweep by grep), or
 * the chat composer, which is its own species.
 */

export type InputGroupProps = {
  /** Drives the padding of the bare <input> inside — see InputGroup.Field. */
  size?: FieldSize;
  /** Dims the whole group. The disabled state belongs to the wrapper here,
   *  because the border being dimmed is most of what "disabled" looks like. */
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
};

/** React context so InputGroup.Field inherits size without prop drilling at each site. */
const SizeContext = React.createContext<FieldSize>('md');

function InputGroupRoot({ size = 'md', disabled, className = '', children }: InputGroupProps) {
  return (
    <SizeContext.Provider value={size}>
      <div
        className={[
          FIELD_SURFACE,
          'flex items-center gap-1',
          // The action sits inset from the border rather than flush against it.
          'pr-1',
          // The focus state the bare input can't express on its own.
          'focus-within:border-accent',
          disabled ? 'opacity-50 cursor-not-allowed' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')
          .trim()}
      >
        {children}
      </div>
    </SizeContext.Provider>
  );
}

export type InputGroupFieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size'
> & {
  /** Overrides the size inherited from the enclosing InputGroup. */
  size?: FieldSize;
};

/**
 * The bare input. Carries the padding and text treatment but no border, no
 * background, and no focus outline — the wrapper owns all three.
 */
const InputGroupField = React.forwardRef<HTMLInputElement, InputGroupFieldProps>(
  function InputGroupField({ size, className = '', type = 'text', ...rest }, ref) {
    const inherited = React.useContext(SizeContext);
    return (
      <input
        ref={ref}
        type={type}
        className={[
          'flex-1 min-w-0 bg-transparent border-0 outline-none',
          FIELD_TEXT,
          FIELD_SIZE[size ?? inherited],
          'disabled:cursor-not-allowed',
          className,
        ]
          .filter(Boolean)
          .join(' ')
          .trim()}
        {...rest}
      />
    );
  },
);

export const InputGroup = Object.assign(InputGroupRoot, { Field: InputGroupField });
