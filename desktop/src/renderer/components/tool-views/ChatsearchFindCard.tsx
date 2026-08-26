import { useEffect } from 'react';
import { useResolvedConversations } from '../../hooks/useResolvedConversations';
import SessionRefActions, { resumeBlockedReason } from './SessionRefActions';
import { formatRelativeTime } from '../../utils/format-time';
import { COPY } from '../../../shared/chatsearch-refs';
import { useTagLabelIndex, resolveChatsearchTags } from './chatsearch-tags';
import { ChatsearchMetaLine } from './ChatsearchMetaLine';
import type { TagRecord } from '../../../shared/tags';
import type { ResolvedConversation } from '../../../shared/chatsearch-refs';

// The owner-approved row (registry.tsx, compare surface 'chatsearch-results',
// Round 2 candidate `b-closed`): no leading mark, title, then the shared
// metadata line. ToolCard's own header already carries the "N past
// conversations" identity and the open/close chevron — this component is
// ONLY the rows, never its own card chrome (Task 4: two headers would say the
// same sentence twice and draw two chevrons for one control).
function ChatsearchRow({ r, tagIndex }: { r: ResolvedConversation; tagIndex: Map<string, TagRecord> }) {
  if (r.status !== 'ok') {
    return (
      <li className="rounded-md bg-inset/50 px-2.5 py-2">
        <div className="text-xs font-mono text-fg-muted truncate">{r.query}</div>
        <div className="text-3xs text-fg-muted">
          {r.status === 'ambiguous' ? COPY.ambiguousId(r.candidates.length) : COPY.unknownId}
        </div>
      </li>
    );
  }
  const blocked = resumeBlockedReason(r);
  return (
    <li className="rounded-md bg-inset/50 px-2.5 py-2 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs truncate text-fg">
          {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
        </div>
        <ChatsearchMetaLine
          tags={resolveChatsearchTags(r.tags, tagIndex)}
          blocked={blocked}
          project={r.projectName || COPY.noProject}
          date={formatRelativeTime(r.lastActive)}
          className="mt-0.5"
        />
      </div>
      <SessionRefActions conversation={r} />
    </li>
  );
}

export default function ChatsearchFindCard({ shortIds, onUnavailable }: { shortIds: string[]; onUnavailable?: () => void }) {
  const { results, loading, unavailable } = useResolvedConversations(shortIds);
  // One registry load for the whole card — rows share it rather than each
  // mounting their own useTagRegistry() (see chatsearch-tags.tsx).
  const tagIndex = useTagLabelIndex();
  useEffect(() => { if (unavailable) onUnavailable?.(); }, [unavailable, onUnavailable]);
  if (unavailable) return null; // ToolBody swaps to plain Bash
  if (loading) return <div className="px-1 py-2 text-xs text-fg-muted">{COPY.lookingUp(shortIds.length)}</div>;
  return (
    <ul className="space-y-1">
      {results.map((r, i) => <ChatsearchRow key={shortIds[i] ?? i} r={r} tagIndex={tagIndex} />)}
    </ul>
  );
}
