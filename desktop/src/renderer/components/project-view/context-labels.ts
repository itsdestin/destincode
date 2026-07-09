import type { ContextFile } from '../../../shared/project-context-types';

// Plain-text load-timing label — spelled out in words, NEVER a glyph (the ●◐○
// status-glyph language is disliked). Shared by ContextTab (row hint) and
// ContextEditorOverlay (meta strip) so the wording can't drift.
export function timingLabel(f: ContextFile): string {
  switch (f.timing) {
    case 'always': return 'Always';
    case 'always-everywhere': return 'Always · everywhere';
    case 'conditional': return f.glob ? `When editing ${f.glob}` : 'Conditional';
    case 'on-recall': return 'On recall';
    case 'index': return 'Index';
    default: return '';
  }
}
