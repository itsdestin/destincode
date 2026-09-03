// src/renderer/dev/workbench/CompareView.tsx
//
// Side-by-side comparison with iteration tracking. Three candidate designs for
// one surface, rendered simultaneously against the same mock backend, with a
// pick recorded per round so a design can be narrowed over several passes:
// pick one of three → Claude authors three more from it → pick again.
//
// WHY THIS EXISTS: the alternatives loop before this ran through a query-param
// switcher (utils/design-variant.ts), which meant flipping between candidates
// one at a time, from memory, and editing the production component to hold all
// of them. Both are bad for judging small differences. Here they sit next to
// each other, the production files stay clean, and the round history says how a
// design got where it did.
//
// WHAT IT IS NOT: a generator. Candidates are authored by Claude in
// compare/registry.tsx — this is the harness that mounts, arranges and records
// them. Picking the last available round tells you to ask for the next one.
//
// Reached at ?mode=workbench&view=compare. Dev-only, like the rest of dev/.
import React from 'react';
import { Select } from '../../components/ui/Select';
import { COMPARE_SURFACES } from './compare/registry';
import { Frame, paneWidthRange } from './compare/Frame';
import type { CompareSurface } from './compare/types';

// Pick history lives in localStorage so a reload — which HMR does constantly —
// doesn't lose the thread. Shape: { [surfaceId]: { [roundNumber]: candidateId } }
const PICKS_KEY = 'youcoded-workbench-compare-picks';
type Picks = Record<string, Record<string, string>>;

function readPicks(): Picks {
  try { return JSON.parse(localStorage.getItem(PICKS_KEY) || '{}') as Picks; } catch { return {}; }
}
function writePicks(p: Picks) {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

export function CompareView() {
  const [surfaceId, setSurfaceId] = React.useState(COMPARE_SURFACES[0]?.id ?? '');
  const [picks, setPicks] = React.useState<Picks>(readPicks);
  const surface: CompareSurface | undefined = COMPARE_SURFACES.find((s) => s.id === surfaceId);

  // The round on screen. Defaults to the furthest one the picks have unlocked,
  // so reopening the workbench resumes where the last session stopped rather
  // than at round 1.
  const surfacePicks = (surface && picks[surface.id]) || {};
  const furthest = React.useMemo(() => {
    if (!surface) return 1;
    let n = 1;
    while (n < surface.rounds.length && surfacePicks[String(n)]) n += 1;
    return n;
  }, [surface, surfacePicks]);
  const [viewingRound, setViewingRound] = React.useState<number | null>(null);
  const round = surface?.rounds[(viewingRound ?? furthest) - 1];

  // Switching surface drops the manual round override — otherwise you land on
  // "round 3" of a surface that only has one.
  React.useEffect(() => { setViewingRound(null); }, [surfaceId]);

  const pick = (candidateId: string) => {
    if (!surface || !round) return;
    const next: Picks = {
      ...picks,
      [surface.id]: { ...(picks[surface.id] ?? {}), [String(round.n)]: candidateId },
    };
    setPicks(next);
    writePicks(next);
    setViewingRound(null);   // jump to whatever this pick unlocked
  };

  const resetSurface = () => {
    if (!surface) return;
    const next = { ...picks };
    delete next[surface.id];
    setPicks(next);
    writePicks(next);
    setViewingRound(null);
  };

  if (!surface || !round) {
    return (
      <div className="h-screen w-screen bg-canvas text-fg flex items-center justify-center p-8">
        <p className="text-sm text-fg-muted">
          No comparisons registered. Add one to dev/workbench/compare/registry.tsx.
        </p>
      </div>
    );
  }

  const pickedThisRound = surfacePicks[String(round.n)];
  const isLastRound = round.n === surface.rounds.length;

  return (
    <div className="h-screen w-screen bg-canvas text-fg flex flex-col overflow-hidden">
      {/* ── Header: what is being compared, and the lineage ─────────────── */}
      <div className="shrink-0 border-b border-edge px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-3xs text-fg-muted">
            Surface
            <Select
              size="sm"
              aria-label="Surface"
              value={surface.id}
              options={COMPARE_SURFACES.map((s) => ({ value: s.id, label: s.label }))}
              onChange={setSurfaceId}
            />
          </label>
          <p className="text-2xs text-fg-2 flex-1 min-w-0">{surface.question}</p>
          {Object.keys(surfacePicks).length > 0 && (
            <button
              type="button"
              onClick={resetSurface}
              className="text-3xs text-fg-muted hover:text-fg transition-colors shrink-0"
            >
              Reset picks
            </button>
          )}
        </div>

        {/* Breadcrumb. Each step is clickable so an earlier round can be
            revisited — the point of tracking rounds is being able to say "R2
            was better than R3", which needs both still reachable. */}
        <div className="flex items-center gap-1 flex-wrap">
          {surface.rounds.map((r, i) => {
            const picked = surfacePicks[String(r.n)];
            const pickedLabel = r.candidates.find((c) => c.id === picked)?.label;
            const current = r.n === round.n;
            return (
              <React.Fragment key={r.n}>
                {i > 0 && <span className="text-fg-faint text-3xs px-0.5">→</span>}
                <button
                  type="button"
                  onClick={() => setViewingRound(r.n)}
                  className={`px-2 py-0.5 rounded-full text-3xs border transition-colors ${
                    current
                      ? 'bg-accent/10 border-accent/40 text-fg'
                      : 'bg-inset border-edge-dim text-fg-muted hover:text-fg'
                  }`}
                >
                  R{r.n}
                  {pickedLabel && <span className="text-fg-muted"> · {pickedLabel}</span>}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {round.basis && (
          <p className="text-3xs text-fg-muted">
            <span className="uppercase tracking-wider">From</span> {round.basis}
          </p>
        )}
      </div>

      {/* ── The three candidates ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <div className="flex items-start gap-4 justify-center flex-wrap">
          {round.candidates.map((c, i) => {
            const chosen = pickedThisRound === c.id;
            return (
              <div key={c.id} className="flex flex-col gap-2" style={{ width: paneWidthRange(surface.paneWidth).min }}>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xs font-medium text-fg-muted">{String.fromCharCode(65 + i)}</span>
                  <span className="text-xs text-fg flex-1 min-w-0 truncate">{c.label}</span>
                  <button
                    type="button"
                    onClick={() => pick(c.id)}
                    className={`text-3xs px-2 py-0.5 rounded-full border transition-colors shrink-0 ${
                      chosen
                        ? 'bg-accent text-on-accent border-accent'
                        : 'bg-inset border-edge-dim text-fg-muted hover:text-fg hover:border-edge'
                    }`}
                  >
                    {chosen ? 'Picked' : 'Pick'}
                  </button>
                </div>
                {c.note && <p className="text-3xs text-fg-muted leading-snug">{c.note}</p>}
                {/* The accent ring marks the pick without recolouring the
                    candidate itself — tinting the surface would change the
                    thing being judged. */}
                <div className={`rounded-lg p-2 ${chosen ? 'ring-2 ring-accent' : ''}`}>
                  <Frame frame={surface.frame} width={paneWidthRange(surface.paneWidth).min}>{c.render()}</Frame>
                </div>
              </div>
            );
          })}
        </div>

        {/* The handoff back to Claude. Without this the view silently dead-ends
            at the last authored round and looks broken. */}
        {pickedThisRound && isLastRound && (
          <p className="text-2xs text-fg-muted text-center mt-6">
            Round {round.n} picked:{' '}
            <span className="text-fg">{round.candidates.find((c) => c.id === pickedThisRound)?.label}</span>.
            {' '}Ask Claude for round {round.n + 1}.
          </p>
        )}
      </div>
    </div>
  );
}
