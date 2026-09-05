import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import {
  fetchCheckouts, fetchInstances, fetchRuns, fetchSuites, fetchWorkspace,
  runCheck, startInstance, stopInstance,
  type Checkout, type Instance, type Run, type Suite, type WorkspaceState,
} from './api';
import { CheckoutRow } from './CheckoutRow';
import { ConfirmDialog } from './ConfirmDialog';
import { buildCleanupPrompt } from './cleanup-prompt';
import { WorkspaceBanner } from './WorkspaceBanner';
import { CopyButton } from './CopyButton';
import { CheckoutDetail } from './CheckoutDetail';
import { ResultsPanel } from './ResultsPanel';

/** Most-fragile first. A page sorted alphabetically buries the one row that
 *  matters among twenty-three that don't. */
const ORDER: Record<Checkout['status'], number> = { unsaved: 0, unpushed: 1, pushed: 2, safe: 3 };

export function DevDashboard() {
  const [checkouts, setCheckouts] = useState<Checkout[] | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [checkingWorkspace, setCheckingWorkspace] = useState(true);
  const [runsDir, setRunsDir] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingPaid, setPendingPaid] = useState<{ id: string; suite: Suite } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, s] = await Promise.all([fetchCheckouts(), fetchSuites()]);
      setCheckouts(c);
      setSuites(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Two passes on purpose. The first reads what git already knows so the banner
  // paints immediately; the second actually fetches from GitHub, so the number on
  // screen is current rather than a remembered one passed off as current.
  const loadWorkspace = useCallback(async () => {
    setCheckingWorkspace(true);
    try {
      setWorkspace(await fetchWorkspace(false));
      setWorkspace(await fetchWorkspace(true));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingWorkspace(false);
    }
  }, [say]);

  useEffect(() => { void load(); void loadWorkspace(); }, [load, loadWorkspace]);

  // Poll only while something is actually in flight: an idle page should be idle.
  // Two seconds is fast enough that a dev window closed by hand updates before
  // the row becomes confusing.
  const busy = instances.some((i) => i.status !== 'exited') || runs.some((r) => r.status === 'running');
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [i, r] = await Promise.all([fetchInstances(), fetchRuns()]);
        if (!cancelled) { setInstances(i); setRuns(r.runs); setRunsDir(r.runsDir); }
      } catch {
        // The helper is down or restarting. Keep the last known state rather than
        // blanking rows the user is reading; the next tick recovers.
      }
    };
    void tick();
    if (!busy) return () => { cancelled = true; };
    const t = setInterval(() => void tick(), 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [busy]);

  const latestRun = useMemo(() => {
    const by = new Map<string, Run>();
    for (const r of runs) {
      const prev = by.get(r.checkoutId);
      if (!prev || r.startedAt > prev.startedAt) by.set(r.checkoutId, r);
    }
    return by;
  }, [runs]);

  const sorted = useMemo(
    () => checkouts && [...checkouts].sort(
      (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name),
    ),
    [checkouts],
  );

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setInstances(await fetchInstances());
      const r = await fetchRuns();
      setRuns(r.runs);
      setRunsDir(r.runsDir);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  }, [say]);

  const doRun = useCallback((id: string, suiteKey: string) => {
    const suite = suites.find((s) => s.key === suiteKey);
    if (!suite) return;
    // The paid one never starts on a single click, no matter where that click
    // came from. The confirmation names the money.
    if (suite.paid) { setPendingPaid({ id, suite }); return; }
    void act(() => runCheck(id, suiteKey));
  }, [suites, act]);

  const failedCount = useMemo(() => runs.filter((r) => r.status === 'failed').length, [runs]);

  const riskyCount = useMemo(
    () => (checkouts ?? []).filter(
      (c) => selected.has(c.id) && (c.status === 'unsaved' || c.status === 'unpushed'),
    ).length,
    [checkouts, selected],
  );

  return (
    // h-full + overflow-y-auto, NOT min-h-screen: globals.css pins html, body and
    // #root to 100dvh with overflow:hidden (right for the app's fixed shell, wrong
    // for a long list), so this page has to be its own scroll container or its
    // bottom rows are simply unreachable.
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl pb-2">
        <header className="mb-4 flex items-center gap-3">
          <h1 className="flex-1 text-base text-fg">Dev dashboard</h1>
          {notice && <span className="max-w-xl truncate text-3xs text-fg-muted">{notice}</span>}
          <Button variant="secondary" size="sm" onClick={() => setResultsOpen((v) => !v)}>
            {resultsOpen ? 'Hide results' : `Results${failedCount ? ` · ${failedCount} failed` : ''}`}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { void load(); void loadWorkspace(); }}
          >
            Refresh
          </Button>
        </header>

        <WorkspaceBanner state={workspace} checking={checkingWorkspace} onError={say} />

        {resultsOpen && (
          <ResultsPanel
            runs={runs}
            suites={suites}
            runsDir={runsDir}
            onNotice={say}
            onClose={() => setResultsOpen(false)}
          />
        )}

        <div className="layer-surface overflow-hidden rounded-lg border border-edge-dim">
          {error && (
            <div className="p-3">
              <ErrorState message={error} onRetry={() => void load()} />
            </div>
          )}
          {!error && sorted === null && <LoadingState what="branch copies" />}
          {!error && sorted?.map((c) => (
            <div key={c.id}>
            <CheckoutRow
              checkout={c}
              instance={instances.find((i) => i.id === c.id)}
              suites={suites}
              run={latestRun.get(c.id)}
              selected={selected.has(c.id)}
              onToggle={(id) => setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })}
              onStart={(id) => void act(() => startInstance(id))}
              onStop={(id) => void act(() => stopInstance(id))}
              onRun={doRun}
              expanded={expanded === c.id}
              onExpand={() => setExpanded(expanded === c.id ? null : c.id)}
              onOpenResults={() => setResultsOpen(true)}
            />
            {expanded === c.id && (
              <CheckoutDetail checkout={c} onNotice={say} onChanged={() => void load()} />
            )}
            </div>
          ))}
        </div>

        {selected.size > 0 && (
          <div className="sticky bottom-0 mt-3 flex items-center gap-3 rounded-lg border border-edge-dim bg-panel px-3 py-2 shadow-lg">
            <span className="flex-1 text-3xs text-fg-muted">
              {selected.size} selected
              {riskyCount > 0 && ` · ${riskyCount} hold the only copy of some work`}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
            <CopyButton
              variant="primary"
              label="Request cleanup"
              copiedLabel="Copied — paste in a new chat"
              onError={say}
              // Clipboard ONLY. No delete button lives on this page: one click
              // from a red "unsaved work" pill is the most dangerous control it
              // could carry, and nothing in the answers asked for one.
              text={() => buildCleanupPrompt((checkouts ?? []).filter((c) => selected.has(c.id)))}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingPaid !== null}
        title="This spends real money"
        body={
          `${pendingPaid?.suite.label} hires real AI models to use the app's tools and grades `
          + 'what they do. It costs roughly 25 cents per case, and is capped at $2.00 per run.\n\n'
          + 'Nothing is spent until you confirm.'
        }
        confirmLabel="Run it"
        onCancel={() => setPendingPaid(null)}
        onConfirm={() => {
          const p = pendingPaid;
          setPendingPaid(null);
          if (p) void act(() => runCheck(p.id, p.suite.key, true));
        }}
      />
    </div>
  );
}
