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
        if (!cancelled) { setInstances(i); setRuns(r); }
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
      setRuns(await fetchRuns());
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

  const riskyCount = useMemo(
    () => (checkouts ?? []).filter(
      (c) => selected.has(c.id) && (c.status === 'unsaved' || c.status === 'unpushed'),
    ).length,
    [checkouts, selected],
  );

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-4 flex items-center gap-3">
          <h1 className="flex-1 text-base text-fg">Dev dashboard</h1>
          {notice && <span className="text-3xs text-fg-muted">{notice}</span>}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { void load(); void loadWorkspace(); }}
          >
            Refresh
          </Button>
        </header>

        <WorkspaceBanner state={workspace} checking={checkingWorkspace} />

        <div className="layer-surface overflow-hidden rounded-lg border border-edge-dim">
          {error && (
            <div className="p-3">
              <ErrorState message={error} onRetry={() => void load()} />
            </div>
          )}
          {!error && sorted === null && <LoadingState what="branch copies" />}
          {!error && sorted?.map((c) => (
            <CheckoutRow
              key={c.id}
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
            />
          ))}
        </div>

        {selected.size > 0 && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-edge-dim bg-panel px-3 py-2">
            <span className="flex-1 text-3xs text-fg-muted">
              {selected.size} selected
              {riskyCount > 0 && ` · ${riskyCount} hold the only copy of some work`}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                const chosen = (checkouts ?? []).filter((c) => selected.has(c.id));
                // Clipboard ONLY. No delete button lives on this page: one click
                // from a red "unsaved work" pill is the most dangerous control it
                // could carry, and nothing in the answers asked for one.
                try {
                  await navigator.clipboard.writeText(buildCleanupPrompt(chosen));
                  say('Cleanup prompt copied — paste it into a new conversation');
                } catch (e) {
                  say(`Could not copy: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}
            >
              Request cleanup
            </Button>
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
