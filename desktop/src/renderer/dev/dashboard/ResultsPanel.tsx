import { useEffect, useState } from 'react';
import { Button, LoadingState } from '../../components/ui';
import { fetchRun, type Run, type Suite } from './api';
import { CopyButton } from './CopyButton';

function when(ms: number): string {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 90) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function took(run: Run): string {
  if (!run.endedAt) return '';
  const s = Math.round((run.endedAt - run.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const TONE: Record<Run['status'], string> = {
  running: 'bg-amber-500',
  passed: 'bg-green-500',
  failed: 'bg-destructive',
};

/** A failure is only useful if you can hand it to someone. The output is often
 *  thousands of lines, so the prompt carries the TAIL — where every one of our
 *  tools puts its verdict — rather than a truncated head that stops before the
 *  answer. */
function buildFailurePrompt(run: Run, suite?: Suite): string {
  const tail = (run.output ?? '').trim().split('\n').slice(-120).join('\n');
  return (
    `The "${suite?.label ?? run.suiteKey}" check failed on ${run.checkoutName ?? 'a branch'}`
    + `${run.checkoutBranch ? ` (${run.checkoutBranch})` : ''}.\n\n`
    + `${suite?.does ? `What that check does: ${suite.does}\n\n` : ''}`
    + `It ran: ${run.command ?? 'unknown command'}\n`
    + `It exited with code ${run.exitCode}.\n\n`
    + `The last of what it printed:\n\n${tail}\n\n`
    + 'Please work out what actually broke and tell me in plain terms, then fix it. '
    + 'Re-run the check yourself to confirm rather than assuming.\n'
  );
}

export function ResultsPanel({ runs, suites, runsDir, onNotice, onClose }: {
  runs: Run[];
  suites: Suite[];
  runsDir: string;
  onNotice: (msg: string) => void;
  onClose: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [full, setFull] = useState<Run | null>(null);

  // The list is polled WITHOUT output (512 KB of build log every two seconds is
  // not a status poll), so opening one fetches it whole.
  useEffect(() => {
    if (!openId) { setFull(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchRun(openId);
        if (!cancelled) setFull(r);
      } catch (e) {
        onNotice(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [openId, onNotice]);

  return (
    <div className="mb-3 rounded-lg border border-edge-dim bg-panel">
      <div className="flex items-center gap-2 border-b border-edge-dim px-3 py-2">
        <span className="flex-1 text-sm text-fg">Check results</span>
        <span className="text-3xs text-fg-faint">{runs.length} kept</span>
        <Button variant="ghost" size="sm" onClick={onClose}>Hide</Button>
      </div>

      {runs.length === 0 ? (
        <p className="px-3 py-3 text-3xs text-fg-muted">
          No checks have been run yet. Pick one from the “Run a check” menu on any row — the
          results land here and stay, including after this tool restarts.
        </p>
      ) : (
        <ul className="max-h-96 overflow-y-auto">
          {runs.map((r) => {
            const suite = suites.find((s) => s.key === r.suiteKey);
            const isOpen = openId === r.runId;
            return (
              <li key={r.runId} className="border-b border-edge-dim last:border-b-0">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[r.status]}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-3xs text-fg-2">
                    {suite?.label ?? r.suiteKey}
                    <span className="text-fg-muted"> on {r.checkoutName ?? r.checkoutId}</span>
                  </span>
                  <span className="shrink-0 text-3xs text-fg-muted">
                    {r.status === 'running' ? 'running…' : r.status === 'passed' ? 'passed' : `failed (exit ${r.exitCode})`}
                  </span>
                  <span className="shrink-0 text-3xs text-fg-faint">{took(r)} · {when(r.startedAt)}</span>
                  <Button variant="ghost" size="sm" onClick={() => setOpenId(isOpen ? null : r.runId)}>
                    {isOpen ? 'Hide' : 'Open'}
                  </Button>
                </div>

                {isOpen && (
                  <div className="px-3 pb-3">
                    {!full && <LoadingState what="the output" variant="inline" />}
                    {full && (
                      <>
                        {suite?.does && (
                          <p className="mb-2 text-3xs leading-relaxed text-fg-muted">{suite.does}</p>
                        )}
                        <pre className="max-h-72 overflow-auto rounded-sm border border-edge-dim bg-well p-2 text-3xs leading-relaxed text-fg-2">
                          {full.output || '(this check printed nothing)'}
                        </pre>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {full.status === 'failed' && (
                            <CopyButton
                              variant="primary"
                              label="Copy a prompt to fix this"
                              copiedLabel="Copied — paste in a new chat"
                              onError={onNotice}
                              text={() => buildFailurePrompt(full, suite)}
                            />
                          )}
                          <CopyButton
                            label="Copy the whole output"
                            onError={onNotice}
                            text={() => full.output ?? ''}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Say where they physically live, because "where do the results go?" is a
          fair question and a tool should be able to answer it. */}
      {runsDir && (
        <p className="border-t border-edge-dim px-3 py-1.5 text-3xs text-fg-faint">
          Kept as files in <span className="font-mono">{runsDir}</span>
        </p>
      )}
    </div>
  );
}

export { buildFailurePrompt };
