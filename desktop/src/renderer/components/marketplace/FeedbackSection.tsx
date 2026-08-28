// Feedback — the section that replaced "Reviews" on the detail page
// (design 2026-08-27, decision #4): one-tap 👍/👎 plus an open comment
// thread. Thumbs still require install + sign-in (the server enforces the
// same rule ratings had, so strangers can't game the number); comments
// require sign-in only. The star widget and the review modal are gone.
//
// Copy rule (G-19): "Helpful 92%" then a muted "402 votes" — never "92% (402)".
import React, { useState } from 'react';
import { useAccount } from '../../state/account-context';
import { useMarketplaceStats } from '../../state/marketplace-stats-context';
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from '../../state/marketplace-api-client';
import { Button, Textarea } from '../ui';
import CommentList from './CommentList';
import SignInPromptModal from './SignInPromptModal';

function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={down ? { transform: 'scaleY(-1)' } : undefined} aria-hidden>
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
      <path d="M7 10l4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7a2 2 0 0 1-2 1.7H7" />
    </svg>
  );
}

/** The one-line summary used on cards and in the section header. Returns
 *  null when there are no votes yet, so nothing renders instead of "0%". */
export function thumbsSummary(up?: number, down?: number): { pct: number; total: number } | null {
  const u = up ?? 0; const d = down ?? 0;
  const total = u + d;
  if (total === 0) return null;
  return { pct: Math.round((u / total) * 100), total };
}

/** Cards show only the percentage (the vote count sat between the % and the
 *  install count and read as one run of digits); the detail page shows both. */
export function ThumbsSummary({ up, down, size = 'sm', showTotal = false }: { up?: number; down?: number; size?: 'sm' | 'md'; showTotal?: boolean }) {
  const s = thumbsSummary(up, down);
  if (!s) return null;
  const cls = size === 'md' ? 'text-sm' : 'text-xs';
  return (
    <span className={`inline-flex items-center gap-1 ${cls} text-fg-dim whitespace-nowrap`} title={`${s.pct}% of ${s.total.toLocaleString()} people who installed this found it helpful`} data-thumbs>
      <span className="inline-flex text-fg-dim"><ThumbIcon /></span>
      <span className="text-fg-2">{s.pct}%</span>
      {showTotal && <span className="text-fg-muted ml-1">{s.total.toLocaleString()}</span>}
    </span>
  );
}

export default function FeedbackSection({ pluginId, installed }: { pluginId: string; installed: boolean }) {
  const stats = useMarketplaceStats();
  const auth = useAccount();
  const s = stats.plugins[pluginId];
  const summary = thumbsSummary(s?.thumbs_up, s?.thumbs_down);

  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [signIn, setSignIn] = useState<null | 'vote' | 'comment'>(null);

  const client = createMarketplaceApiClient({ host: MARKETPLACE_API_HOST, getToken: () => null });

  const castVote = (v: 'up' | 'down') => {
    if (!auth.signedIn) { setSignIn('vote'); return; }
    const next = vote === v ? null : v;
    setVote(next);
    client.setThumb({ plugin_id: pluginId, value: next }).then(() => stats.refresh()).catch(() => undefined);
  };

  const post = () => {
    const text = draft.trim();
    if (!text) return;
    if (!auth.signedIn) { setSignIn('comment'); return; }
    setPosting(true);
    client.postComment({ plugin_id: pluginId, text })
      .then(() => { setDraft(''); setRefresh((n) => n + 1); })
      .catch(() => undefined)
      .finally(() => setPosting(false));
  };

  const voteReason = !installed ? 'Install it first — only people who have used it can vote' : !auth.signedIn ? 'Sign in to vote' : undefined;

  return (
    <section data-feedback>
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-sm uppercase tracking-wide text-fg-dim">Feedback</h2>
          {summary
            ? <span className="text-sm text-fg-2">Helpful <span className="text-fg">{summary.pct}%</span> <span className="text-fg-muted">{summary.total.toLocaleString()} votes</span></span>
            : <span className="text-sm text-fg-dim">No votes yet</span>}
        </div>
        {/* Both `secondary sm` — the page's one primary is Install (G-4). */}
        <div className="flex items-center gap-1.5" role="group" aria-label="Was this helpful?">
          <Button variant="secondary" size="sm" onClick={() => castVote('up')} disabled={!installed} title={voteReason ?? 'Helpful'} aria-pressed={vote === 'up'} className={vote === 'up' ? 'ring-1 ring-accent' : ''}>
            <ThumbIcon /> Helpful
          </Button>
          <Button variant="secondary" size="sm" onClick={() => castVote('down')} disabled={!installed} title={voteReason ?? 'Not for me'} aria-pressed={vote === 'down'} className={vote === 'down' ? 'ring-1 ring-accent' : ''}>
            <ThumbIcon down /> Not for me
          </Button>
        </div>
      </div>

      <CommentList pluginId={pluginId} refreshKey={refresh} />

      {/* Composer — anyone signed in can ask a question or report how it went;
          you do NOT need to have installed it to ask. */}
      <div className="mt-3 flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={auth.signedIn ? 'Ask a question or say how it went…' : 'Sign in to comment'}
          aria-label="Write a comment"
        />
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={post} disabled={posting || draft.trim().length === 0} title={!auth.signedIn ? 'Sign in to comment' : undefined}>
            {posting ? 'Posting…' : 'Post comment'}
          </Button>
        </div>
      </div>

      <SignInPromptModal
        open={signIn !== null}
        onClose={() => setSignIn(null)}
        title={signIn === 'vote' ? 'Sign in to vote' : 'Sign in to comment'}
        message={signIn === 'vote' ? 'Votes are tied to your account so each person counts once.' : 'Comments show your marketplace handle.'}
      />
    </section>
  );
}
