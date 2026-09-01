// src/renderer/dev/workbench/compare/CandidateBoundary.tsx
//
// WHY this exists, and why it is a class: a component that throws during render
// unmounts the WHOLE React root, not just its own subtree. Without a boundary,
// one broken candidate blanks every pane on a review page at once — and a blank
// pane beside three working ones reads as "that design is empty", not "that
// design crashed". React only offers error catching to class components; there
// is no hook equivalent.
import React from 'react';

interface Props { children: React.ReactNode; label?: string }
interface State { error: Error | null }

export class CandidateBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The console is where a session looks; the pane below is where Destin does.
    console.error('[compare] candidate threw while rendering', this.props.label ?? '', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Specific and accurate (docs/error-message-standards.md): the real thrown
    // message and the head of the stack, never a guessed cause.
    const head = (error.stack ?? '').split('\n').slice(0, 4).join('\n');
    return (
      <div className="rounded-lg border border-red-500/40 bg-inset p-3 text-2xs text-fg-2 overflow-auto">
        <p className="font-medium text-red-400 mb-1">
          This candidate threw while rendering{this.props.label ? ` (${this.props.label})` : ''}.
        </p>
        <p className="mb-2">{error.message || String(error)}</p>
        {head && <pre className="whitespace-pre-wrap text-3xs text-fg-muted leading-snug">{head}</pre>}
      </div>
    );
  }
}
