// The pushed review sub-view (mockup ledger 10-13, spec section 2). Mirror,
// not gate: everything shown here is a live read of git state; staging is the
// real index; refresh rides git:changed. The standard drawer top bar stays in
// the host — this component starts at the sub-header row.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UnifiedDiff } from '../diff/UnifiedDiff';
import { formatRelativeTime } from '../../utils/format-time';
import { Button, Textarea } from '../ui';
import { GitReviewCard } from './GitReviewCard';
import type { GitFileReviewResult, GitLogEntry } from '../../../shared/git-types';
import type { StructuredPatchHunk } from '../../../shared/types';

export interface GitReviewViewProps {
  projectRoot: string;
  /** project-root-relative path of the file under review (artifact.path) */
  relPath: string;
  fileName: string;
  onBack: () => void;
  /** open the L3 discard confirm; willTrash = HEAD has no copy, so discard
   *  trashes the file instead of restoring (Task 9 wires the dialog) */
  onRequestDiscard: (willTrash: boolean) => void;
  /** Surfaced by the caller (e.g. a failed discard) in the same error slot as
   *  opError — ONE error surface, not two competing banners (Task 9). */
  externalError?: string | null;
  /** Called at the top of run() so a new git op supersedes a stale external
   *  error (e.g. discardError) instead of leaving it displayed forever. */
  onExternalErrorClear?: () => void;
}

function gitApi(): any {
  return (window as any).claude?.git;
}

export function GitReviewView({
  projectRoot, relPath, fileName, onBack, onRequestDiscard,
  externalError, onExternalErrorClear,
}: GitReviewViewProps) {
  const [review, setReview] = useState<GitFileReviewResult | null>(null);
  const [extraLog, setExtraLog] = useState<GitLogEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['uncommitted']));
  // Error-message standard: a failed `commitFileDiff` fetch (ok:false, or a
  // rejected promise) must surface the real backend string, never collapse
  // into the same 'empty' state as a genuinely change-free commit.
  const [commitDiffs, setCommitDiffs] = useState<Map<string, StructuredPatchHunk[] | 'loading' | 'empty' | { error: string }>>(new Map());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(() => {
    gitApi()?.fileReview?.(projectRoot, relPath)
      .then((r: GitFileReviewResult) => { if (aliveRef.current && r?.ok) { setReview(r); } })
      .catch(() => {});
  }, [projectRoot, relPath]);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    // NOTE: this only re-fetches ON a `git:changed` event — it does not itself
    // register the `git:watch` subscription that produces those events. That
    // registration lives in the host footer's useGitFileStatus hook, so this
    // view's live refresh depends on the host keeping that subscription alive.
    const off = gitApi()?.onChanged?.(() => refresh()) ?? (() => {});
    return () => { aliveRef.current = false; off(); };
  }, [refresh]);

  const toggle = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const expandCommit = (entry: GitLogEntry) => {
    const sha = entry.sha;
    toggle(sha);
    if (!commitDiffs.has(sha)) {
      setCommitDiffs((m) => new Map(m).set(sha, 'loading'));
      // WHY entry.pathAtCommit not relPath: git log --follow tracks renames,
      // so a commit before the file's rename lived at a different path —
      // asking git show with the CURRENT path returns an empty diff for
      // those commits (the bug this fixes). Pass the historical name, and
      // for the rename commit itself also pass renamedFrom so the main
      // process can pair the rename with -M instead of rendering the
      // add-side full-file wall.
      gitApi()?.commitFileDiff?.(projectRoot, sha, entry.pathAtCommit ?? relPath, entry.renamedFrom)
        .then((d: { ok: boolean; hunks: StructuredPatchHunk[]; error?: string }) => {
          if (!aliveRef.current) return;
          // ok:false is a real backend failure, not "no changes" — surface it.
          if (!d.ok) { setCommitDiffs((m) => new Map(m).set(sha, { error: d.error ?? 'git show failed' })); return; }
          setCommitDiffs((m) => new Map(m).set(sha, d.hunks.length > 0 ? d.hunks : 'empty'));
        })
        .catch((e: unknown) => {
          if (aliveRef.current) {
            setCommitDiffs((m) => new Map(m).set(sha, { error: e instanceof Error ? e.message : String(e) }));
          }
        });
    }
  };

  const showMore = () => {
    const skip = (review?.log.length ?? 0) + extraLog.length;
    gitApi()?.fileReview?.(projectRoot, relPath, { logSkip: skip })
      .then((r: GitFileReviewResult) => {
        if (aliveRef.current && r?.ok) {
          setExtraLog((prev) => [...prev, ...r.log]);
          setReview((prev) => (prev ? { ...prev, hasMore: r.hasMore } : prev));
        }
      })
      .catch(() => {});
  };

  const run = async (op: () => Promise<{ ok: boolean; error?: string }>) => {
    // Serialize git ops: without this guard, a second run() while one is
    // in-flight wipes the first's opError and re-enables mid-op (the commit
    // button already checked `busy` via canCommit, but stage/unstage didn't).
    if (busy) return false;
    setBusy(true);
    setOpError(null);
    // A new op (stage/unstage/commit) supersedes any stale externally-surfaced
    // error (e.g. a prior failed discard) — one error surface, not a leftover.
    onExternalErrorClear?.();
    try {
      const r = await op();
      // Real stderr passthrough (error-message standard) — never a guessed cause.
      if (!r.ok) setOpError(r.error ?? 'git operation failed');
      else refresh();
      return r.ok;
    } finally { setBusy(false); }
  };

  const stagedCount = review?.stagedCount ?? 0;
  const canCommit = !busy && stagedCount > 0 && message.trim().length > 0;
  const uncommitted = review?.uncommitted ?? null;
  const log = [...(review?.log ?? []), ...extraLog];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* sub-header BENEATH the standard drawer top bar (ledger 10, locked) */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-edge-dim bg-well shrink-0">
        <button
          type="button"
          onClick={onBack}
          title="Back to file view"
          className="w-7 h-7 rounded-md inline-flex items-center justify-center shrink-0 border transition-colors text-fg-dim border-transparent hover:text-fg hover:bg-inset hover:border-edge"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-fg-2 truncate">Reviewing changes for “{fileName}”</span>
        <div className="flex-1" />
        {review?.branch && (
          <span className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono text-fg-dim border border-edge-dim" title="Current branch">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
              <path d="M6 8.5v7M18 10.5c0 3-4 3.5-7 3.5" />
            </svg>
            {review.branch}
          </span>
        )}
      </div>

      {/* card timeline */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        {uncommitted && (
          <GitReviewCard
            accent
            expanded={expanded.has('uncommitted')}
            onToggle={() => toggle('uncommitted')}
            headerLeft={<span className="text-xs font-semibold text-fg flex-1">Uncommitted changes</span>}
            headerRight={
              <>
                <span className="text-[10px] font-mono text-green-400">+{uncommitted.counts.added}</span>
                <span className="text-[10px] font-mono text-red-400">−{uncommitted.counts.removed}</span>
              </>
            }
          >
            {uncommitted.binary ? (
              <div className="text-[11px] text-fg-muted py-1">Binary or oversized file — no line diff.</div>
            ) : (
              // Cap the diff's own height and let IT scroll, not the card —
              // a long diff used to render full-height, ballooning the card
              // to the point it looked scrollable but wasn't. UnifiedDiff
              // already frames itself (rounded-sm border-edge), so this outer
              // box only adds the height cap, no second border. The action
              // row below (staged checkbox / revert button) stays a
              // sibling of this div, not a child, so it's always visible.
              <div className="max-h-[45vh] overflow-y-auto overscroll-contain">
                <UnifiedDiff oldStr="" newStr="" structuredPatch={uncommitted.hunks} />
              </div>
            )}
            <div className="flex items-center gap-1.5 mt-2">
              {/* Legible mirror (owner decision 2026-07-23): the checkbox used
                  to hide behind !uncommitted.untracked, so a brand-new file
                  had no way to be included in a commit from this view. The
                  backend already handles it — staging an untracked file is a
                  plain `git add`, and the mirror refresh flips the card to
                  staged like any other file. */}
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => (uncommitted.staged
                  ? gitApi().unstage(projectRoot, relPath)
                  : gitApi().stage(projectRoot, relPath)))}
                className="flex items-center gap-1.5 text-[11px] text-fg-2 hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  {uncommitted.staged && <path d="m8 12.5 3 3 5.5-6.5" />}
                </svg>
                Include in commit
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => onRequestDiscard(!uncommitted.inHead)}
                className="px-2 py-1 rounded-md text-[11px] text-destructive-fg hover:bg-destructive/10 transition-colors"
              >
                Revert Changes…
              </button>
            </div>
          </GitReviewCard>
        )}

        {log.map((entry) => {
          const body = commitDiffs.get(entry.sha);
          return (
            <GitReviewCard
              key={entry.sha}
              expanded={expanded.has(entry.sha)}
              onToggle={() => expandCommit(entry)}
              headerLeft={
                <>
                  <span className="font-mono text-[11px] text-fg-faint">{entry.shortSha}</span>
                  <span className="text-xs text-fg-2 truncate flex-1">{entry.subject}</span>
                </>
              }
              headerRight={
                <>
                  {/* Same +N/−N glyphs as the uncommitted card's headerRight —
                      null (binary, or a chunk with no numstat line) shows no
                      count at all rather than a misleading +0/−0. */}
                  {entry.counts && (
                    <>
                      <span className="text-[10px] font-mono text-green-400">+{entry.counts.added}</span>
                      <span className="text-[10px] font-mono text-red-400">−{entry.counts.removed}</span>
                    </>
                  )}
                  <span className="text-[11px] text-fg-faint whitespace-nowrap">{formatRelativeTime(entry.authorDate)}</span>
                </>
              }
            >
              {body === 'loading' && <div className="text-[11px] text-fg-muted py-1">Loading…</div>}
              {/* A rename-only commit (renamedFrom set) with no content change is an
                  honest "moved" state, not the generic "no changes" line — that
                  copy stays reserved for the merge-commit case (no name-status
                  line at all, entry.renamedFrom undefined). */}
              {body === 'empty' && (
                entry.renamedFrom
                  ? <div className="text-[11px] text-fg-muted py-1">Moved from “{entry.renamedFrom}” — no content changes in this commit.</div>
                  : <div className="text-[11px] text-fg-muted py-1">No direct changes to this file in this commit.</div>
              )}
              {body && typeof body === 'object' && !Array.isArray(body) && (
                <div className="text-[11px] text-fg-muted py-1 break-words">{body.error}</div>
              )}
              {/* Same height-cap-with-inner-scroll wrapper as the uncommitted
                  card above — see the WHY comment there. */}
              {Array.isArray(body) && (
                <div className="max-h-[45vh] overflow-y-auto overscroll-contain">
                  <UnifiedDiff oldStr="" newStr="" structuredPatch={body} />
                </div>
              )}
            </GitReviewCard>
          );
        })}

        {review?.hasMore && (
          <button
            type="button"
            onClick={showMore}
            className="text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg-2 py-1"
          >
            Show more
          </button>
        )}
      </div>

      {/* composer (ledger 13): counts staged files REPO-WIDE — a commit always
          commits the whole index, including files the agent staged meanwhile.
          WHY conditional on uncommitted: a clean file's review is read-only, so
          no commit affordance should appear. */}
      {uncommitted && (
        <div className="shrink-0 border-t border-edge px-2 py-2 bg-inset">
          {(opError ?? externalError) && (
            <div className="mb-1 px-2.5 py-1.5 text-[11px] text-fg rounded-md border border-edge bg-well break-all">
              {opError ?? externalError}
            </div>
          )}
          <Textarea
            size="sm"
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            className="w-full"
          />
          <Button
            size="md"
            variant="primary"
            disabled={!canCommit}
            className="mt-1 w-full"
            onClick={async () => {
              const ok = await run(() => gitApi().commit(projectRoot, message));
              if (ok) setMessage('');
            }}
          >
            {`Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`}
          </Button>
          {/* Empty-cart hint (owner decision 2026-07-23): the commit button is
              disabled whenever nothing is staged, but that gave no clue WHY —
              this line only shows up in that state. */}
          {stagedCount === 0 && (
            <div className="mt-1 text-[11px] text-fg-muted">
              Tick “Include in commit” on a change above to choose what gets committed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
