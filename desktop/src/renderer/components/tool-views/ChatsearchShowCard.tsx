import { useEffect } from 'react';
import { useResolvedConversations } from '../../hooks/useResolvedConversations';
import SessionRefActions from './SessionRefActions';
import { formatRelativeTime } from '../../utils/format-time';
import { COPY, providerLabel } from '../../../shared/chatsearch-refs';

export default function ChatsearchShowCard({ id, provider, onUnavailable }: { id: string; provider: string; onUnavailable?: () => void }) {
  const { results, loading, unavailable } = useResolvedConversations([id]);
  useEffect(() => { if (unavailable) onUnavailable?.(); }, [unavailable, onUnavailable]);
  if (unavailable) return null;
  if (loading) return <div className="px-1 py-2 text-xs text-fg-muted">{COPY.lookingUp(1)}</div>;
  const r = results[0];
  if (!r || r.status !== 'ok') return <div className="px-1 py-2 text-xs text-fg-muted"><span className="font-mono">{id.slice(0, 8)}</span> — {COPY.unknownId}</div>;
  return (
    <div className="rounded-lg border border-edge bg-well px-4 py-3">
      <div className="text-2xs uppercase tracking-wider text-fg-muted mb-1">{COPY.headerShow} · {providerLabel(provider)}</div>
      <h4 className="text-base font-medium text-fg mb-0.5">{r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}</h4>
      <div className="text-xs text-fg-muted mb-3">
        {formatRelativeTime(r.lastActive)} · {r.projectName || COPY.noProject}
        {r.tags.length > 0 && <> · {r.tags.map((t) => `#${t}`).join(' ')}</>}
        {r.tombstone && <> · {COPY.previewTombstone}</>}
      </div>
      <SessionRefActions conversation={r} size="md" />
    </div>
  );
}
