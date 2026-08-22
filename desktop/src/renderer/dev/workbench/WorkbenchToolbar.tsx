import React from 'react';
import { Select } from '../../components/ui/Select';
import { Toggle } from '../../components/ui/Toggle';
import { getLatency, setLatency } from './mock-shim';
import { SCENARIO_IDS } from './scenarios';

const LATENCIES = [
  { value: '0', label: 'instant' },
  { value: '150', label: '150ms' },
  { value: '2000', label: '2s (slow)' },
];

const VIEWS = [
  { value: 'app', label: 'app' },
  { value: 'tools', label: 'tool gallery' },
  { value: 'compare', label: 'comparisons' },
];




export interface WorkbenchToolbarProps {
  narrow: boolean;
  onNarrow: (v: boolean) => void;
  view: string;
  onView: (v: string) => void;
}

/**
 * Workbench chrome. Uses the app's own `components/ui` primitives rather than
 * hand-rolled controls — the workbench is not exempt from the primitive rule,
 * and using them is free extra exercise of them.
 *
 * WHY NO THEME PICKER: the app already has one (Settings → Appearance), and it
 * is the real control, so switching there exercises the shipping code path
 * instead of a parallel one. A toolbar picker would also need `useTheme()`,
 * which lives inside `<App/>`'s provider tree — a toolbar rendered as App's
 * SIBLING has no access to it, and wrapping the frame in a second ThemeProvider
 * would leave two providers writing the same `<html>` attributes and the same
 * localStorage key, with the app's inner one able to clobber the outer at any
 * re-render. Not worth it to duplicate a control the app already has.
 *
 * This is also what resolves spec §11's "where does the toolbar mount" question:
 * because it needs no app context, it can sit cleanly outside the app frame.
 */
export function WorkbenchToolbar({ narrow, onNarrow, view, onView }: WorkbenchToolbarProps) {
  const scenario = new URLSearchParams(location.search).get('scenario') ?? 'default';
  const stalled = new URLSearchParams(location.search).get('stalled') === '1';
  const [latency, setLatencyState] = React.useState(String(getLatency()));

  const reloadWith = (key: string, value: string) => {
    const u = new URL(location.href);
    u.searchParams.set(key, value);
    location.assign(u.toString());
  };

  return (
    <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 bg-panel border-b border-edge">
      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
        Workbench
      </span>

      <label className="flex items-center gap-1.5 text-3xs text-fg-muted">
        View
        <Select
          size="sm"
          aria-label="View"
          value={view}
          options={VIEWS}
          onChange={onView}
        />
      </label>

      {/* Scenario reseeds the store, so it reloads rather than mutating live —
          most surfaces have already read their data by the time you change it. */}
      <label className="flex items-center gap-1.5 text-3xs text-fg-muted">
        Scenario
        <Select
          size="sm"
          aria-label="Scenario"
          value={scenario}
          options={SCENARIO_IDS.map((s) => ({ value: s, label: s }))}
          onChange={(next) => reloadWith('scenario', next)}
        />
      </label>

      {/* Fake IPC latency. Spec §4 — this is the difference the workbench would
          otherwise hide, and hiding it is how UI-first development ships
          surfaces with loading states nobody ever saw. Applies immediately: the
          shim reads the value per call, so no reload is needed. */}
      <label className="flex items-center gap-1.5 text-3xs text-fg-muted">
        Latency
        <Select
          size="sm"
          aria-label="Latency"
          value={latency}
          options={LATENCIES}
          onChange={(next) => { setLatency(Number(next)); setLatencyState(next); }}
        />
      </label>

      {/* Parks the native fixture's turn so the red "Provider may have
          stalled" card can be reviewed. A toggle rather than the fixture's
          permanent state: it used to be always-on, which put the red card over
          the shared native session in EVERY scenario (M9). Reloads for the same
          reason Scenario does — the timeline is seeded once, at hydrate. */}
      <label className="flex items-center gap-1.5 text-3xs text-fg-muted">
        Stalled turn
        <Toggle
          checked={stalled}
          onChange={(v) => reloadWith('stalled', v ? '1' : '0')}
          aria-label="Stalled turn"
        />
      </label>

      <span className="text-3xs text-fg-faint">
        Themes: Settings → Appearance
      </span>

      <label className="ml-auto flex items-center gap-1.5 text-3xs text-fg-muted">
        Narrow (640px)
        <Toggle checked={narrow} onChange={onNarrow} aria-label="Narrow viewport" />
      </label>
    </div>
  );
}
