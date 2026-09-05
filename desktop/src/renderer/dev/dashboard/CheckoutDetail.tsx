import { useEffect, useState } from 'react';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import {
  backupCheckout, fetchDetail, type Checkout, type CheckoutDetailData,
} from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyButton } from './CopyButton';
import { buildSaveWorkPrompt, buildReviewPrompt } from './cleanup-prompt';

// Enough to see the shape of the work without the panel becoming the page. A
// branch with 200 changed files would otherwise push every action off screen.
const PER_KIND = 12;

function Files({ detail }: { detail: CheckoutDetailData }) {
  if (detail.files.length === 0) {
    return <p className="text-3xs text-fg-muted">Nothing uncommitted — everything here is saved to git.</p>;
  }
  return (
    <div className="space-y-2">
      {Object.entries(detail.byKind).map(([kind, files]) => (
        <div key={kind}>
          <div className="text-3xs uppercase tracking-wide text-fg-faint">
            {kind} · {files.length}
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {files.slice(0, PER_KIND).map((f) => (
              <li key={f.file} className="flex items-baseline gap-2 text-3xs">
                <span className="min-w-0 flex-1 truncate text-fg-2">{f.file}</span>
                <span className="shrink-0 text-fg-muted">{f.state}</span>
                {/* No count for a brand-new file: "0 lines" reads as empty, which
                    is the opposite of true. */}
                {f.added !== null && (
                  <span className="shrink-0 tabular-nums text-fg-faint">
                    +{f.added} −{f.removed}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {files.length > PER_KIND && (
            <div className="mt-0.5 text-3xs text-fg-faint">
              …and {files.length - PER_KIND} more. The copyable prompt below carries the full list.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function CheckoutDetail({ checkout, onNotice, onChanged }: {
  checkout: Checkout;
  onNotice: (msg: string) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CheckoutDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmBackup, setConfirmBackup] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  const load = async () => {
    setError(null);
    try { setDetail(await fetchDetail(checkout.id)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [checkout.id]);

  const atRisk = checkout.status === 'unsaved';

  return (
    <div className="border-t border-edge-dim bg-well/40 px-3 py-3 pl-8">
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && !detail && <LoadingState what="what is in this folder" variant="inline" />}

      {detail && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-3xs text-fg-muted">
            <span>Last commit {detail.lastCommitRel ?? 'unknown'}</span>
            {detail.pr?.unavailable && <span>PR status unavailable (gh could not be reached)</span>}
            {detail.pr && !detail.pr.unavailable && (
              <span>
                PR #{detail.pr.number} · {detail.pr.isDraft ? 'draft' : (detail.pr.state ?? 'unknown').toLowerCase()}
              </span>
            )}
            {detail.pr === null && <span>No pull request</span>}
            <span className="font-mono text-fg-faint">{checkout.path}</span>
          </div>

          {/* WHAT THIS BRANCH WAS FOR — the answer to "what even is leu-t13". */}
          {detail.commits.length > 0 && (
            <div>
              <div className="text-3xs uppercase tracking-wide text-fg-faint">
                What this branch did ({detail.commits.length} change{detail.commits.length === 1 ? '' : 's'} beyond master)
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {detail.commits.map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-2 text-3xs">
                    <span className="min-w-0 flex-1 truncate text-fg-2">{c.subject}</span>
                    <span className="shrink-0 text-fg-faint">{c.when}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* WHAT IS UNSAVED — the answer to "it says unsaved work, so what?" */}
          <div>
            <div className="mb-1 text-3xs uppercase tracking-wide text-fg-faint">
              Not saved to git
              {detail.totals.files > 0 && ` · ${detail.totals.files} file(s)`}
            </div>
            <Files detail={detail} />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-edge-dim pt-2">
            {atRisk && (
              <Button variant="primary" size="sm" disabled={backingUp} onClick={() => setConfirmBackup(true)}>
                {backingUp ? 'Saving…' : 'Back this up to GitHub'}
              </Button>
            )}
            <CopyButton
              label={atRisk ? 'Copy a prompt to deal with it' : 'Copy a prompt about this branch'}
              copiedLabel="Copied — paste in a new chat"
              onError={onNotice}
              text={() => (atRisk
                ? buildSaveWorkPrompt(checkout, detail)
                : buildReviewPrompt(checkout, detail))}
            />
            <CopyButton
              label="Copy the folder path"
              onError={onNotice}
              text={() => checkout.path}
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmBackup}
        title="Back this work up to GitHub"
        body={
          `This records the ${checkout.dirty} uncommitted file(s) in ${checkout.name} as a new `
          + 'branch and pushes it, so the work exists somewhere other than this disk.\n\n'
          + 'Your files are NOT moved, changed or removed. They stay in the folder exactly as '
          + 'they are, still uncommitted — a session working there will not notice anything. '
          + 'No existing branch moves, and nothing touches master.\n\n'
          + 'It only adds a copy.'
        }
        confirmLabel="Back it up"
        onCancel={() => setConfirmBackup(false)}
        onConfirm={async () => {
          setConfirmBackup(false);
          setBackingUp(true);
          try {
            const r = await backupCheckout(checkout.id);
            onNotice(r.ok ? r.note : r.error);
            onChanged();
            await load();
          } catch (e) {
            onNotice(e instanceof Error ? e.message : String(e));
          } finally {
            setBackingUp(false);
          }
        }}
      />
    </div>
  );
}
