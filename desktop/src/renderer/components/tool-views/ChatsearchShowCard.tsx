import { useEffect } from 'react';
import { useResolvedConversations } from '../../hooks/useResolvedConversations';
import SessionRefActions, { resumeBlockedReason } from './SessionRefActions';
import { formatRelativeTime } from '../../utils/format-time';
import { COPY } from '../../../shared/chatsearch-refs';
import { useTagLabelIndex, resolveChatsearchTags } from './chatsearch-tags';
import { ChatsearchMetaLine } from './ChatsearchMetaLine';

// Task 4: this used to draw its own `rounded-lg border border-edge bg-well`
// box with a "Past conversation · <provider>" header line. That header said
// exactly what ToolCard's own header already says (COPY.headerShow, via
// friendlyToolDisplay) — two headers, two chevrons, one sentence twice. So
// this component is now just the body: title, the same metadata-line
// composition the find rows use, and the same real Preview/Resume. It reads
// as the same family of object as a find row, just singular and a size up on
// the title (text-base vs text-xs) to carry the "slightly more prominent"
// the owner asked for.
export default function ChatsearchShowCard({ id, provider: _provider, onUnavailable }: { id: string; provider: string; onUnavailable?: () => void }) {
  const { results, loading, unavailable } = useResolvedConversations([id]);
  const tagIndex = useTagLabelIndex();
  useEffect(() => { if (unavailable) onUnavailable?.(); }, [unavailable, onUnavailable]);
  if (unavailable) return null;
  if (loading) return <div className="px-1 py-2 text-xs text-fg-muted">{COPY.lookingUp(1)}</div>;
  const r = results[0];
  if (!r || r.status !== 'ok') return <div className="px-1 py-2 text-xs text-fg-muted"><span className="font-mono">{id.slice(0, 8)}</span> — {COPY.unknownId}</div>;
  const blocked = resumeBlockedReason(r);
  return (
    <div>
      <h4 className="text-base font-medium text-fg">
        {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
      </h4>
      <ChatsearchMetaLine
        tags={resolveChatsearchTags(r.tags, tagIndex)}
        blocked={blocked}
        project={r.projectName || COPY.noProject}
        date={formatRelativeTime(r.lastActive)}
        className="mt-1"
      />
      <div className="mt-3">
        <SessionRefActions conversation={r} size="md" />
      </div>
    </div>
  );
}
