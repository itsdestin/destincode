import { Button, Checkbox, Select } from '../../components/ui';
import type { Checkout, Instance, Run, Suite } from './api';
import { Disclosure } from './Disclosure';
import { StatusPill, pillDetail } from './StatusPill';

const VERDICT: Record<Run['status'], (r: Run) => string> = {
  running: () => 'Running…',
  passed: () => 'Passed',
  // The exit code is all we honestly know without parsing each suite's output;
  // saying "2 tests failed" would be a guess. The details hold the real answer.
  failed: (r) => `Failed (exit ${r.exitCode})`,
};

export function CheckoutRow({
  checkout, instance, suites, run, selected,
  onToggle, onStart, onStop, onRun,
}: {
  checkout: Checkout;
  instance?: Instance;
  suites: Suite[];
  run?: Run;
  selected: boolean;
  onToggle: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRun: (id: string, suiteKey: string) => void;
}) {
  const live = instance && instance.status !== 'exited';

  return (
    <div className="border-b border-edge-dim px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-3">
        {/* The main checkout is not a cleanup candidate, so it has no tick box —
            a disabled one still reads as "you could". */}
        {checkout.isMain
          ? <span className="w-4 shrink-0" aria-hidden="true" />
          : <Checkbox checked={selected} onChange={() => onToggle(checkout.id)} />}

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-fg">{checkout.name}</div>
          {/* The measurements are VISIBLE, not in a tooltip. Destin drives this
              machine by touch, where `title=` never fires — load-bearing copy in a
              hover is copy he can never read (.claude/rules/narrow-viewport.md). */}
          <div className="truncate text-3xs text-fg-muted">
            {checkout.missing
              ? 'folder is gone — registered but not on disk'
              : `${checkout.branch ?? 'no branch (detached)'} · ${pillDetail(checkout)}`}
          </div>
        </div>

        <StatusPill status={checkout.status} isMain={checkout.isMain} />

        <div className="w-44 shrink-0">
          <Select
            options={suites.map((s) => ({ value: s.key, label: `${s.label} · ${s.weight}` }))}
            value=""
            placeholder="Run a check…"
            size="sm"
            aria-label={`Run a check on ${checkout.name}`}
            onChange={(v) => { if (v) onRun(checkout.id, v); }}
          />
        </div>

        {live ? (
          <div className="flex shrink-0 items-center gap-2">
            {/* The port is shown because it is how Destin tells two open dev
                windows apart when both are on screen at once. */}
            <span className="text-3xs text-fg-muted">
              {instance!.status === 'starting'
                ? 'starting…'
                : `running · :${5173 + instance!.offset}`}
            </span>
            <Button variant="secondary" size="sm" onClick={() => onStop(checkout.id)}>Stop</Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={checkout.missing}
            onClick={() => onStart(checkout.id)}
          >
            Launch
          </Button>
        )}
      </div>

      {/* A dev instance that died on startup says so with the script's own last
          words, rather than vanishing back to a Launch button as if nothing
          happened. */}
      {instance?.status === 'exited' && instance.error && (
        <div className="mt-1.5 pl-8">
          <Disclosure summary="Launch failed — show details">{instance.error}</Disclosure>
        </div>
      )}

      {run && (
        <div className="mt-1.5 flex items-baseline gap-3 pl-8">
          <span className="shrink-0 text-3xs text-fg-2">
            {suites.find((s) => s.key === run.suiteKey)?.label ?? run.suiteKey}: {VERDICT[run.status](run)}
          </span>
          {run.status !== 'running' && run.output && (
            <Disclosure summary="Show details">{run.output}</Disclosure>
          )}
        </div>
      )}
    </div>
  );
}
