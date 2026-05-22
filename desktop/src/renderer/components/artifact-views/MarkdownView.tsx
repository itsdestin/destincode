// Task 6.4: MarkdownView is now a fully controlled component.
// Edit state (editing, draft) is managed by ActiveArtifactView in SessionDrawer.tsx
// so the conflict banner has access to the in-progress draft.
import MarkdownContent from '../MarkdownContent';
import type { ArtifactViewProps } from './types';

export function MarkdownView({
  path, content, isEditable,
  editing = false, draft = '', onDraftChange, onStartEdit, onSaveEdit, onCancelEdit,
}: ArtifactViewProps) {
  if (content === null) {
    return <div className="text-fg-muted p-4">⚠ file not on disk</div>;
  }

  if (editing) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex gap-2 p-2 border-b border-edge">
          <button
            className="px-3 py-1 rounded bg-accent text-on-accent"
            onClick={onSaveEdit}
          >
            Save
          </button>
          <button
            className="px-3 py-1 rounded border border-edge"
            onClick={onCancelEdit}
          >
            Cancel
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(e) => onDraftChange?.(e.target.value)}
          className="flex-1 w-full p-3 bg-inset text-fg font-mono text-sm resize-none focus:outline-none"
        />
      </div>
    );
  }

  const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown');
  return (
    <div className="flex flex-col h-full">
      {isEditable && (
        <div className="flex gap-2 p-2 border-b border-edge">
          <button
            className="px-3 py-1 rounded border border-edge hover:bg-inset"
            onClick={onStartEdit}
          >
            Edit
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto p-4">
        {isMarkdown
          ? <MarkdownContent content={content} />
          : <pre className="font-mono text-sm whitespace-pre-wrap">{content}</pre>}
      </div>
    </div>
  );
}
