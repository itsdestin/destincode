import { useState } from 'react';
import MarkdownContent from '../MarkdownContent';
import type { ArtifactViewProps } from './types';

export function MarkdownView({ path, content, isEditable, onEdit }: ArtifactViewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content ?? '');

  if (content === null) {
    return <div className="text-fg-muted p-4">⚠ file not on disk</div>;
  }

  if (editing) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex gap-2 p-2 border-b border-edge">
          <button
            className="px-3 py-1 rounded bg-accent text-on-accent"
            onClick={() => { onEdit?.(draft); setEditing(false); }}
          >
            Save
          </button>
          <button
            className="px-3 py-1 rounded border border-edge"
            onClick={() => { setDraft(content); setEditing(false); }}
          >
            Cancel
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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
            onClick={() => setEditing(true)}
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
