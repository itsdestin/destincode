import MarkdownContent from '../MarkdownContent';
import type { ArtifactViewProps } from './types';

export function CodeView({ path, content, editing = false, draft = '', onDraftChange }: ArtifactViewProps) {
  if (content === null) {
    return <div className="text-fg-muted p-4">This file is no longer on disk.</div>;
  }

  // Controlled edit branch, same contract as MarkdownView (D4 unlock): a plain
  // textarea for now — CodeMirror replaces this render in the CM6 step. The
  // artifact-edit-textarea class keeps the right-click Cut/Copy/Paste menu.
  if (editing) {
    return (
      <div className="flex flex-col h-full">
        <textarea
          value={draft}
          onChange={(e) => onDraftChange?.(e.target.value)}
          className="artifact-edit-textarea flex-1 w-full p-3 bg-inset text-fg font-mono text-sm resize-none focus:outline-none"
          inputMode="text"
          enterKeyHint="enter"
          spellCheck={false}
        />
      </div>
    );
  }

  const lang = path.split('.').pop() ?? '';
  // Reuses the chat markdown highlighter by wrapping in a fenced code block.
  const wrapped = '```' + lang + '\n' + content + '\n```';
  return (
    <div
      className="overflow-auto p-4 h-full"
      data-artifact-viewer
      data-doc-path={path}
      data-artifact-source="raw"
    >
      <MarkdownContent content={wrapped} />
    </div>
  );
}
