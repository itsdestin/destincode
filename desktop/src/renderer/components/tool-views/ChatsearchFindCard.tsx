import { useEffect } from 'react';
import { useResolvedConversations } from '../../hooks/useResolvedConversations';
import SessionRefActions from './SessionRefActions';
import { formatRelativeTime } from '../../utils/format-time';
import { COPY } from '../../../shared/chatsearch-refs';

export default function ChatsearchFindCard({ shortIds, onUnavailable }: { shortIds: string[]; onUnavailable?: () => void }) {
  const { results, loading, unavailable } = useResolvedConversations(shortIds);
  useEffect(() => { if (unavailable) onUnavailable?.(); }, [unavailable, onUnavailable]);
  if (unavailable) return null; // ToolBody swaps to plain Bash
  if (loading) return <div className="px-1 py-2 text-xs text-fg-muted">{COPY.lookingUp(shortIds.length)}</div>;
  return (
    <ul className="divide-y divide-edge rounded-md border border-edge">
      {results.map((r, i) => (
        <li key={shortIds[i] ?? i} className="flex items-center gap-3 px-3 py-2">
          {r.status === 'ok' ? (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">
                  {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
                  {r.tombstone && <span className="ml-1 text-fg-muted" title={COPY.previewTombstone}>†</span>}
                </div>
                <div className="truncate text-xs text-fg-muted">
                  {formatRelativeTime(r.lastActive)} · {r.projectName || COPY.noProject}
                  {r.tags.length > 0 && <> · {r.tags.map((t) => `#${t}`).join(' ')}</>}
                </div>
              </div>
              <SessionRefActions conversation={r} />
            </>
          ) : (
            <div className="min-w-0 flex-1 text-xs text-fg-muted">
              {/* Fix: the status text needs its OWN element so it has an exact
                  textContent a11y queries (and getByText) can match — a bare
                  text sibling next to the id span merges into the parent's
                  combined text and is never selectable on its own. */}
              <span className="font-mono">{r.query}</span> — <span>{r.status === 'ambiguous' ? COPY.ambiguousId(r.candidates.length) : COPY.unknownId}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
