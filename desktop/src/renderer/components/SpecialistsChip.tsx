import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useSpecialistSummary, type SpecialistSummary, type AskSegment } from '../hooks/useSpecialists';
import { SpecialistAskBlock } from './specialists/SpecialistAskBlock';
import { SpecialistActions } from './specialists/SpecialistActions';
import { RunStatusLine } from './specialists/RunStatusLine';
import { friendlyToolDisplay } from './ToolCard';
import BrailleSpinner from './BrailleSpinner';
import { CheckIcon, QuestionIcon, StoppedIcon } from './Icons';
import type { SpecialistRunView } from '../../shared/types';

/**
 * Specialists 1c — the status-bar chip (spec §6 "attention, not vigilance")
 * and the popup behind it, which is where helpers are MANAGED (Destin, round
 * 1: an ask buried inside a Task card is impossible to navigate — the card
 * still shows it, but this is the one place to answer every waiting ask, send
 * a note, or stop a helper without hunting through the conversation).
 *
 * The chip is quiet ("3 specialists") while helpers work and turns amber
 * ("2 need you") when an ask is waiting. Hidden when there is nothing to say —
 * same rule as OpenTasksChip. One indicator on purpose; the cross-conversation
 * inbox is later work.
 */
export default function SpecialistsChip({ sessionId }: { sessionId: string | null | undefined }) {
  const summary = useSpecialistSummary(sessionId ?? undefined);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  const total = summary.running.length + summary.waiting.length + summary.finished.length;
  if (total === 0) return null;

  const needsYou = summary.waiting.length;
  const label = needsYou > 0
    ? `${needsYou} need${needsYou === 1 ? 's' : ''} you`
    : summary.running.length > 0
      ? `${summary.running.length} specialist${summary.running.length === 1 ? '' : 's'}`
      : `${summary.finished.length} finished`;
  const tooltip = needsYou > 0
    ? `${needsYou} specialist ask${needsYou === 1 ? '' : 's'} waiting on you — click to answer`
    : summary.running.length > 0
      ? `${summary.running.length} specialist${summary.running.length === 1 ? '' : 's'} working — click to manage`
      : 'Specialists finished in the background — click to see';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
        style={needsYou > 0
          // Amber = the same "waiting on you" tone the permission chip family uses.
          ? { backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.4)' }
          : { backgroundColor: 'var(--inset)', color: 'var(--fg-muted)', borderColor: 'var(--edge-dim)' }}
        title={tooltip}
        aria-label={tooltip}
        data-testid="specialists-chip"
      >
        {needsYou > 0 ? <QuestionIcon className="w-3 h-3" /> : summary.running.length > 0 ? <BrailleSpinner size="xs" /> : <CheckIcon className="w-3 h-3" />}
        <span>{label}</span>
      </button>
      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: CONTENT_Z[2] }}>
            <OverlayPanel
              layer={2}
              className="w-full max-w-[560px] max-h-[85vh] flex flex-col pointer-events-auto"
              style={{ position: 'relative', zIndex: 'auto' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
                <div>
                  <h2 className="text-sm font-bold text-fg">Specialists</h2>
                  <p className="text-2xs text-fg-muted">
                    {needsYou > 0 ? `${needsYou} waiting on you` : 'Nothing needs you'}
                    {summary.running.length > 0 ? ` · ${summary.running.length} working` : ''}
                    {summary.finished.length > 0 ? ` · ${summary.finished.length} finished` : ''}
                  </p>
                </div>
                <button onClick={() => setOpen(false)}
                  className="text-fg-muted hover:text-fg-2 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset">×</button>
              </div>
              <div className="px-3 py-3 overflow-y-auto space-y-2">
                <SpecialistManager summary={summary} sessionId={sessionId ?? undefined} onJump={() => setOpen(false)} />
              </div>
            </OverlayPanel>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

interface HelperRow {
  key: string;
  run?: SpecialistRunView;
  parentToolCallId: string;
  asks: Array<{ segment: AskSegment; held: boolean }>;
  kind: 'waiting' | 'running' | 'finished';
}

/** One block per helper — asks first (they need you), then working, then finished. */
function SpecialistManager({ summary, sessionId, onJump }: { summary: SpecialistSummary; sessionId?: string; onJump: () => void }) {
  const rows = new Map<string, HelperRow>();
  for (const w of summary.waiting) {
    const key = w.run?.childId ?? w.parentToolCallId;
    const row = rows.get(key) ?? { key, run: w.run, parentToolCallId: w.parentToolCallId, asks: [], kind: 'waiting' as const };
    row.asks.push({ segment: w.segment, held: w.held });
    row.kind = 'waiting';
    rows.set(key, row);
  }
  for (const r of summary.running) if (!rows.has(r.childId)) rows.set(r.childId, { key: r.childId, run: r, parentToolCallId: r.parentToolCallId, asks: [], kind: 'running' });
  for (const r of summary.finished) if (!rows.has(r.childId)) rows.set(r.childId, { key: r.childId, run: r, parentToolCallId: r.parentToolCallId, asks: [], kind: 'finished' });
  const ordered = [...rows.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
  return (
    <>
      {ordered.map(row => <HelperBlock key={row.key} row={row} sessionId={sessionId} onJump={onJump} />)}
    </>
  );
}

function rank(kind: HelperRow['kind']): number { return kind === 'waiting' ? 0 : kind === 'running' ? 1 : 2; }

function HelperBlock({ row, sessionId, onJump }: { row: HelperRow; sessionId?: string; onJump: () => void }) {
  const run = row.run;
  const first = run?.title.split(' ')[0];
  const icon = row.kind === 'waiting'
    ? <QuestionIcon className="w-3.5 h-3.5 text-amber-500" />
    : run?.status === 'running' ? <BrailleSpinner size="xs" />
    : run?.status === 'interrupted' ? <StoppedIcon className="w-3.5 h-3.5 text-fg-muted" />
    : <CheckIcon className="w-3.5 h-3.5 text-fg-muted" />;
  return (
    <div className={`rounded-lg border ${row.kind === 'waiting' ? 'border-amber-500/40' : 'border-edge'} bg-inset/40 overflow-hidden`} data-testid={`helper-block-${row.key}`}>
      <div className="px-3 py-2 flex items-start gap-2">
        <span className="shrink-0 inline-flex mt-0.5">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-fg-2">{run?.title ?? 'A specialist'}</span>
            {run && <span className="text-4xs uppercase tracking-wide px-1 rounded border border-edge text-fg-muted">{run.agentType}</span>}
          </div>
          {run?.description && <div className="text-2xs text-fg-dim">{run.description}</div>}
          {run && <RunStatusLine run={run} />}
        </div>
        <button
          type="button"
          onClick={() => { jumpToCard(row.parentToolCallId); onJump(); }}
          className="text-2xs text-fg-muted hover:text-fg-2 shrink-0"
          title="Scroll to this helper's card in the conversation"
        >
          Show in chat ↗
        </button>
      </div>
      {row.asks.map(({ segment }) => {
        const { label, detail } = friendlyToolDisplay({
          toolUseId: segment.toolUseId, toolName: segment.toolName, input: segment.input, status: segment.status,
        });
        return (
          <div key={segment.requestId} className="border-t border-edge/60">
            <div className="px-3 pt-2 text-xs">
              <span className="font-medium text-fg-2">{first ?? 'The specialist'} wants to: </span>
              <span className="text-fg-2">{label}</span>
              {detail && <span className="text-fg-muted"> {detail}</span>}
            </div>
            <SpecialistAskBlock segment={segment} sessionId={sessionId} specialistName={first} />
          </div>
        );
      })}
      {run && run.status === 'running' && sessionId && (
        <div className="border-t border-edge/60 px-3 py-2">
          <SpecialistActions sessionId={sessionId} run={run} />
        </div>
      )}
      {row.kind === 'finished' && (
        <div className="border-t border-edge/60 px-3 py-1.5 text-2xs text-fg-muted">
          Finished in the background — the report is on its card.
        </div>
      )}
    </div>
  );
}

/** Scroll the launching Task card into view and flash it. ToolCard stamps
 *  `data-tool-use-id` on its root for exactly this. */
export function jumpToCard(toolUseId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('specialist-jump-flash');
  setTimeout(() => el.classList.remove('specialist-jump-flash'), 1600);
}
