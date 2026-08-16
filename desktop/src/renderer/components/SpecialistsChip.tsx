import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useSpecialistSummary, type SpecialistSummary } from '../hooks/useSpecialists';
import BrailleSpinner from './BrailleSpinner';
import { CheckIcon, QuestionIcon } from './Icons';
import type { SpecialistRunView } from '../../shared/types';

/**
 * Specialists 1c — the status-bar chip (spec §6 "attention, not vigilance"):
 * a quiet "2 specialists" while helpers work that becomes a badge when one
 * needs the user (an ask waiting) or has finished in the background. Hidden
 * when there is nothing to say — same rule as OpenTasksChip. Click opens a
 * small list: who, doing what, for how long, and a Jump that scrolls the
 * launching Task card into view. One indicator on purpose; the full
 * cross-conversation inbox is later work.
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
    ? `${needsYou} specialist ask${needsYou === 1 ? '' : 's'} waiting on you — click to see`
    : summary.running.length > 0
      ? `${summary.running.length} specialist${summary.running.length === 1 ? '' : 's'} working — click to see`
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
              className="w-full max-w-[420px] max-h-[80vh] flex flex-col pointer-events-auto"
              style={{ position: 'relative', zIndex: 'auto' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
                <h2 className="text-sm font-bold text-fg">Specialists in this conversation</h2>
                <button onClick={() => setOpen(false)}
                  className="text-fg-muted hover:text-fg-2 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset">×</button>
              </div>
              <div className="px-2 py-2 overflow-y-auto">
                <SpecialistList summary={summary} onJump={() => setOpen(false)} />
              </div>
            </OverlayPanel>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

function SpecialistList({ summary, onJump }: { summary: SpecialistSummary; onJump: () => void }) {
  const rows: Array<{ key: string; run?: SpecialistRunView; parentToolCallId: string; kind: 'waiting' | 'running' | 'finished'; extra?: string }> = [];
  for (const w of summary.waiting) rows.push({ key: `w-${w.requestId}`, run: w.run, parentToolCallId: w.parentToolCallId, kind: 'waiting', extra: w.held ? 'asked 5+ min ago — still answerable' : `wants to use ${w.toolName}` });
  for (const r of summary.running) if (!rows.some(x => x.run?.childId === r.childId)) rows.push({ key: `r-${r.childId}`, run: r, parentToolCallId: r.parentToolCallId, kind: 'running' });
  for (const r of summary.finished) if (!rows.some(x => x.run?.childId === r.childId)) rows.push({ key: `f-${r.childId}`, run: r, parentToolCallId: r.parentToolCallId, kind: 'finished' });
  return (
    <ul className="space-y-0.5">
      {rows.map(row => (
        <li key={row.key}>
          <button
            type="button"
            onClick={() => { jumpToCard(row.parentToolCallId); onJump(); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-inset text-left"
          >
            <span className="shrink-0 inline-flex text-fg-muted">
              {row.kind === 'waiting' ? <QuestionIcon className="w-3.5 h-3.5 text-amber-500" /> : row.kind === 'running' ? <BrailleSpinner size="xs" /> : <CheckIcon className="w-3.5 h-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-fg-2 truncate">{row.run?.title ?? 'A specialist'}</span>
              <span className="block text-2xs text-fg-muted truncate">
                {row.run?.description ?? ''}
                {row.extra ? ` · ${row.extra}` : row.kind === 'running' ? ` · working${row.run?.background ? ' in the background' : ''}` : row.kind === 'finished' ? ' · finished — report is on its card' : ''}
              </span>
            </span>
            <span className="text-2xs text-fg-muted shrink-0">Jump ↗</span>
          </button>
        </li>
      ))}
    </ul>
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
