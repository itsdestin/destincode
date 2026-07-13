// src/renderer/components/tags/TagPicker.tsx
import React, { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { TAG_COLORS, DEFAULT_TAG_COLOR, TagColor } from '../../../shared/tags';
import { TagRegistryApi } from '../../hooks/useTagRegistry';
import { TagChip } from './TagChip';

export function TagPicker({ appliedIds, onToggle, registry }: {
  appliedIds: Set<string>;
  onToggle: (tagId: string, next: boolean) => void;
  registry: TagRegistryApi;
}) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => registry.tags
    .filter((t) => showArchived || !t.archived)
    .filter((t) => !q || t.label.toLowerCase().includes(q)), [registry.tags, q, showArchived]);

  const exactExists = registry.tags.some((t) => t.label.toLowerCase() === q && !t.archived);
  const canCreate = q.length > 0 && !exactExists;

  const handleCreate = async () => {
    const tag = await registry.create(query.trim(), DEFAULT_TAG_COLOR);
    if (tag) { onToggle(tag.id, true); setQuery(''); }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) { e.preventDefault(); handleCreate(); } }}
        placeholder="Search or create a tag…"
        className="w-full rounded-sm bg-inset text-fg text-[11px] px-2 py-1 border border-edge-dim focus:border-accent outline-none"
      />
      <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
        {canCreate && (
          <button onClick={handleCreate}
            className="text-left px-2 py-1 text-[11px] rounded-sm hover:bg-inset text-accent">
            + Create “{query.trim()}”
          </button>
        )}
        {visible.map((t) => (
          <TagRow key={t.id} tag={t} applied={appliedIds.has(t.id)}
            editing={editing === t.id}
            onToggle={() => onToggle(t.id, !appliedIds.has(t.id))}
            onEdit={() => setEditing(editing === t.id ? null : t.id)}
            registry={registry} />
        ))}
        {visible.length === 0 && !canCreate && (
          <div className="px-2 py-1 text-[10px] text-fg-faint">No tags yet — type a name to create one.</div>
        )}
      </div>
      <button onClick={() => setShowArchived((v) => !v)}
        className="self-start text-[9px] text-fg-faint hover:text-fg-muted">
        {showArchived ? 'Hide archived' : 'Show archived'}
      </button>
    </div>
  );
}

function TagRow({ tag, applied, editing, onToggle, onEdit, registry }: {
  tag: TagRecord; applied: boolean; editing: boolean;
  onToggle: () => void; onEdit: () => void; registry: TagRegistryApi;
}) {
  const [label, setLabel] = useState(tag.label);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-1 py-1 rounded-sm hover:bg-inset">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 text-left min-w-0">
          <span className="w-3 h-3 shrink-0 rounded-sm border"
            style={{ backgroundColor: applied ? `var(--${tag.color})` : 'transparent',
                     borderColor: `var(--${tag.color})` }} />
          <TagChip tag={tag} />
          {tag.archived && <span className="text-[9px] text-fg-faint shrink-0">archived</span>}
        </button>
        <button onClick={onEdit} className="text-fg-faint hover:text-fg-muted text-[10px] shrink-0" title="Edit tag" aria-label="Edit tag">✎</button>
      </div>
      {editing && (
        <div className="ml-5 mr-1 mb-1 flex flex-col gap-1.5 p-2 rounded-sm bg-inset border border-edge-dim">
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { if (label.trim() && label !== tag.label) registry.update(tag.id, { label: label.trim() }); }}
            className="rounded-sm bg-canvas text-fg text-[11px] px-1.5 py-1 border border-edge-dim outline-none" />
          <div className="flex flex-wrap gap-1">
            {TAG_COLORS.map((c) => (
              <button key={c} onClick={() => registry.update(tag.id, { color: c as TagColor })}
                className={`w-4 h-4 rounded-full border ${tag.color === c ? 'ring-2 ring-offset-1 ring-offset-inset ring-fg-dim' : ''}`}
                style={{ backgroundColor: `var(--${c})`, borderColor: `var(--${c})` }}
                aria-label={c} title={c} />
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={() => registry.update(tag.id, { archived: !tag.archived })}
              className="text-[10px] text-fg-muted hover:text-fg">{tag.archived ? 'Unarchive' : 'Archive'}</button>
            <button onClick={() => registry.remove(tag.id)}
              className="text-[10px] text-[#DD4444] hover:brightness-125">Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}
