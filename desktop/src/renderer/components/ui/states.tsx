import React from 'react';
import BrailleSpinner from '../BrailleSpinner';
import { Button } from './Button';

/**
 * The loading / empty / error family (changes 31-34, §1.6).
 *
 * Shared anatomy: [mark] message [action].
 * Marks carry meaning — braille spinner = working, nothing = empty,
 * destructive dot = failed.
 *
 * Two variants everywhere:
 *   block  — list surfaces, text-sm, vertical breathing room
 *   inline — inside sections, text-2xs, tight
 */

export type StateVariant = 'block' | 'inline';

export type LoadingStateProps = {
  /** What is loading. Always name it — "Loading sessions…", not "Loading…". */
  what: string;
  variant?: StateVariant;
  className?: string;
};

export function LoadingState({ what, variant = 'block', className = '' }: LoadingStateProps) {
  const block = variant === 'block';
  return (
    <div
      className={[
        block
          ? 'flex items-center justify-center gap-2 py-8 text-sm text-fg-muted'
          : 'flex items-center gap-2 px-1 text-2xs text-fg-muted',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <BrailleSpinner size={block ? 'sm' : 'xs'} />
      <span>Loading {what}…</span>
    </div>
  );
}

export type EmptyStateProps = {
  message: React.ReactNode;
  /** Optional way out — "Clear filters", "Browse themes". */
  action?: { label: string; onClick: () => void };
  variant?: StateVariant;
  className?: string;
};

export function EmptyState({ message, action, variant = 'block', className = '' }: EmptyStateProps) {
  const block = variant === 'block';
  return (
    <div
      className={[
        // No mark: absence IS the empty state's mark.
        block ? 'flex flex-col items-center gap-2 py-8' : 'flex items-center gap-3 px-1',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={block ? 'text-sm text-fg-muted text-center' : 'text-2xs text-fg-muted'}>
        {message}
      </span>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** The failure mark. Shared with Toast's error tone. */
function ErrorDot() {
  return <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" aria-hidden="true" />;
}

type ErrorStateRecoverable = {
  mode?: 'recoverable';
  /** Specific and accurate — the real detail, never a guessed cause. */
  message: React.ReactNode;
  onRetry: () => void;
  variant?: StateVariant;
  className?: string;
};

type ErrorStateGeneral = {
  mode: 'general';
  title: React.ReactNode;
  explainer: React.ReactNode;
  onReportBug: () => void;
  onDiagnose: () => void;
  className?: string;
};

export type ErrorStateProps = ErrorStateRecoverable | ErrorStateGeneral;

/**
 * Option C, chosen explicitly over A ("quiet inline") and B ("destructive-tinted
 * callout"): the container is NEUTRAL, and the destructive dot alone carries the
 * failure. Errors are not red boxes (design rule 6).
 *
 * The `general` mode IS the two-action fallback component that
 * docs/error-message-standards.md schedules for v1.3.1 — every user-facing error
 * is either specific+Retry or general+two-actions.
 */
export function ErrorState(props: ErrorStateProps) {
  const container = `bg-inset/50 rounded-lg p-3 ${props.className ?? ''}`.trim();

  if (props.mode === 'general') {
    return (
      <div className={container} role="alert">
        <div className="flex items-start gap-2">
          <span className="mt-1.5">
            <ErrorDot />
          </span>
          <div className="flex flex-col gap-2 min-w-0">
            <span className="text-sm font-medium text-fg">{props.title}</span>
            <span className="text-2xs text-fg-dim leading-relaxed">{props.explainer}</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={props.onReportBug}>
                Report bug
              </Button>
              <Button variant="primary" size="sm" onClick={props.onDiagnose}>
                Diagnose with Claude
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const block = (props.variant ?? 'block') === 'block';
  return (
    <div className={container} role="alert">
      <div className="flex items-center gap-2">
        <ErrorDot />
        <span className={`flex-1 min-w-0 text-fg-2 ${block ? 'text-sm' : 'text-2xs'}`}>
          {props.message}
        </span>
        {/* Retry is FILLED primary — an explicit review correction from secondary,
            because secondary reads as a dim outline on dark themes. */}
        <Button variant="primary" size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export type FieldErrorProps = {
  children: React.ReactNode;
  className?: string;
};

/** Field-level errors stay short lines under the input — not cards. */
export function FieldError({ children, className = '' }: FieldErrorProps) {
  return (
    <span className={`text-3xs text-destructive-fg ${className}`.trim()} role="alert">
      {children}
    </span>
  );
}
