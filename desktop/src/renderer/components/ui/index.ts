/**
 * Shared UI primitives. Import from here: `import { Button } from '../ui'`.
 *
 * These are the app's control vocabulary — every button, toggle, field, tab row,
 * and state surface goes through them (design rules 1-18). Hand-rolling
 * `bg-accent text-on-accent` or a fifth toggle geometry is what this directory
 * exists to prevent.
 *
 * Full recipes and the reasoning behind each decision:
 * docs/active/specs/2026-07-16-ui-consistency-design-spec.md
 */

export { Button, buttonClasses, BUTTON_BASE, BUTTON_VARIANT, BUTTON_SIZE, FOCUS_RING } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { CloseButton } from './CloseButton';
export type { CloseButtonProps } from './CloseButton';

export { Toggle } from './Toggle';
export type { ToggleProps, ToggleTone } from './Toggle';

export { FIELD, FIELD_SIZE, fieldClasses } from './field';
export type { FieldSize } from './field';

export { TextInput } from './TextInput';
export type { TextInputProps } from './TextInput';

export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';

export { Select } from './Select';
export type { SelectProps, SelectOption } from './Select';

export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';

export { Radio, RadioGroup } from './Radio';
export type { RadioProps, RadioGroupProps } from './Radio';

export { LoadingState, EmptyState, ErrorState, FieldError } from './states';
export type { LoadingStateProps, EmptyStateProps, ErrorStateProps, FieldErrorProps, StateVariant } from './states';

export { AnchorTip } from './AnchorTip';
export type { AnchorTipProps, AnchorTipTrigger, AnchorTipPlacement } from './AnchorTip';

export { Toast } from './Toast';
export type { ToastProps, ToastTone } from './Toast';

export { SegmentedTabs } from './SegmentedTabs';
export type { SegmentedTabsProps, SegmentedTab } from './SegmentedTabs';

export { ProgressBar } from './ProgressBar';
export type { ProgressBarProps } from './ProgressBar';
