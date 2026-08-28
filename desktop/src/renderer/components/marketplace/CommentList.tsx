// CommentList — the thread of comments under a marketplace item. Grew out of
// ReviewList (avatar · login · text · date · report) when the overhaul
// (2026-08-27, decision #4) replaced star reviews with one-tap thumbs plus
// an open comment thread: same row, no stars.
//
//   - Fetches via apiClient.listComments() on mount and whenever refreshKey changes
//   - LoadingState / EmptyState / error, populated list
//   - React auto-escapes text content so comment text is XSS-safe as written
//   - AbortController cancels the in-flight fetch on unmount or refreshKey change

import React, { useEffect, useState } from 'react';
import {
  createMarketplaceApiClient,
  MARKETPLACE_API_HOST,
  type CommentEntry,
} from '../../state/marketplace-api-client';
import ReportReviewButton from './ReportReviewButton';
import { LoadingState, EmptyState } from '../ui';

// Unauthenticated client — listComments is a public endpoint
const apiClient = createMarketplaceApiClient({
  host: MARKETPLACE_API_HOST,
  getToken: () => null,
});

/** "3 days ago" / "2 weeks ago" — comments are conversation, so relative
 *  time reads better than a full date; the exact date sits in the title. */
function relativeDate(unixSec: number): { text: string; title: string } {
  const d = new Date(unixSec * 1000);
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  const text = days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : days < 60 ? `${Math.floor(days / 7)} weeks ago` : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return { text, title: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) };
}

function CommentRow({ c, pluginId }: { c: CommentEntry; pluginId: string }) {
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const when = relativeDate(c.created_at);
  return (
    <div className="flex flex-col gap-1 py-3 border-b border-edge-dim last:border-0" data-comment>
      <div className="flex items-center gap-2">
        {c.user_avatar_url && !avatarFailed ? (
          <img src={c.user_avatar_url} alt={c.user_login} onError={() => setAvatarFailed(true)} className="w-6 h-6 rounded-full shrink-0 object-cover" />
        ) : (
          <span className="w-6 h-6 rounded-full bg-accent/20 shrink-0 flex items-center justify-center text-2xs font-bold text-accent">
            {c.user_login.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="text-xs font-medium text-fg">{c.user_login}</span>
        <span className="ml-auto text-2xs text-fg-muted shrink-0" title={when.title}>{when.text}</span>
        <ReportReviewButton ratingUserId={c.user_id} pluginId={pluginId} reviewerLogin={c.user_login} />
      </div>
      <p className="text-sm text-fg-2 leading-relaxed whitespace-pre-wrap pl-8">{c.text}</p>
    </div>
  );
}

interface CommentListProps {
  pluginId: string;
  /** Bump to re-fetch (e.g. after the user posts). */
  refreshKey?: number;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'loaded'; comments: CommentEntry[] }
  | { status: 'error' };

export default function CommentList({ pluginId, refreshKey = 0 }: CommentListProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });
    const controller = new AbortController();
    let cancelled = false;
    apiClient.listComments(pluginId, controller.signal)
      .then(({ comments }) => {
        if (cancelled) return;
        setState(comments.length === 0 ? { status: 'empty' } : { status: 'loaded', comments });
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setState({ status: 'error' });
      });
    return () => { cancelled = true; controller.abort(); };
  }, [pluginId, refreshKey]);

  return (
    <div>
      {state.status === 'loading' && <LoadingState variant="inline" what="comments" />}
      {state.status === 'empty' && <EmptyState variant="inline" message="No comments yet — ask a question or say how it went." />}
      {state.status === 'error' && <p className="text-xs text-destructive-fg">Couldn't load comments.</p>}
      {state.status === 'loaded' && (
        <div>
          {state.comments.map((c) => <CommentRow key={c.id} c={c} pluginId={pluginId} />)}
        </div>
      )}
    </div>
  );
}
