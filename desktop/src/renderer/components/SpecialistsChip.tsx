import { useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { useSpecialistSummary, type SpecialistSummary, type AskSegment } from '../hooks/useSpecialists';
import { SpecialistAskBlock } from './specialists/SpecialistAskBlock';
import { SpecialistActions } from './specialists/SpecialistActions';
import { formatElapsed } from './specialists/RunStatusLine';
import { friendlyToolDisplay } from './ToolCard';
import { Dialog } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { CheckIcon, QuestionIcon } from './Icons';
import type { SpecialistRunView } from '../../shared/types';

/**
 * Specialists 1c — the status-bar chip (spec §6 "attention, not vigilance")
 * and the popup behind it, which is where helpers are MANAGED (Destin, round
 * 1: an ask buried inside a Task card is impossible to navigate — the card
 * still shows it, but this is the one place to answer every waiting ask, send
 * a note, or stop a helper without hunting through the conversation).
 *
 * Round 3: built in the app's list-popup language (OpenTasksPopup is the
 * sibling) — <Dialog>, uppercase section headers, flat rows with a status
 * dot, hover-revealed ghost actions. No cards inside cards.
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
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Specialists"
          subtitle={[
            needsYou > 0 ? `${needsYou} waiting on you` : null,
            summary.running.length > 0 ? `${summary.running.length} working` : null,
            summary.finished.length > 0 ? `${summary.finished.length} finished` : null,
          ].filter(Boolean).join(' · ')}
          size="panel"
        >
          <SpecialistManager summary={summary} sessionId={sessionId ?? undefined} onJump={() => setOpen(false)} />
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

interface HelperRow {
  key: string;
  run?: SpecialistRunView;
  parentToolCallId: string;
  asks: AskSegment[];
  group: 'needs-you' | 'working' | 'finished';
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase px-2 pt-2 pb-1">{label}</div>
  );
}

/** Rows grouped Needs you → Working → Finished, the same shape OpenTasksPopup uses. */
function SpecialistManager({ summary, sessionId, onJump }: { summary: SpecialistSummary; sessionId?: string; onJump: () => void }) {
  const rows = new Map<string, HelperRow>();
  for (const w of summary.waiting) {
    const key = w.run?.childId ?? w.parentToolCallId;
    const row = rows.get(key) ?? { key, run: w.run, parentToolCallId: w.parentToolCallId, asks: [], group: 'needs-you' as const };
    row.asks.push(w.segment);
    row.group = 'needs-you';
    rows.set(key, row);
  }
  for (const r of summary.running) if (!rows.has(r.childId)) rows.set(r.childId, { key: r.childId, run: r, parentToolCallId: r.parentToolCallId, asks: [], group: 'working' });
  for (const r of summary.finished) if (!rows.has(r.childId)) rows.set(r.childId, { key: r.childId, run: r, parentToolCallId: r.parentToolCallId, asks: [], group: 'finished' });
  const all = [...rows.values()];
  const needs = all.filter(r => r.group === 'needs-you');
  const working = all.filter(r => r.group === 'working');
  const finished = all.filter(r => r.group === 'finished');
  return (
    <>
      {needs.length > 0 && (<>
        <SectionHeader label="Needs you" />
        {needs.map(r => <Row key={r.key} row={r} sessionId={sessionId} onJump={onJump} />)}
      </>)}
      {working.length > 0 && (<>
        <SectionHeader label="Working" />
        {working.map(r => <Row key={r.key} row={r} sessionId={sessionId} onJump={onJump} />)}
      </>)}
      {finished.length > 0 && (<>
        <SectionHeader label="Finished" />
        {finished.map(r => <Row key={r.key} row={r} sessionId={sessionId} onJump={onJump} />)}
      </>)}
    </>
  );
}

function StatusDot({ group, stale }: { group: HelperRow['group']; stale?: boolean }) {
  if (group === 'needs-you') {
    return <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#fbbf24', boxShadow: '0 0 0 2px rgba(251,191,36,0.25)' }} />;
  }
  if (group === 'working') {
    return <span className="inline-block w-2 h-2 rounded-full" style={{ background: stale ? '#fbbf24' : '#60a5fa', boxShadow: `0 0 0 2px ${stale ? 'rgba(251,191,36,0.25)' : 'rgba(96,165,250,0.25)'}` }} />;
  }
  return <span className="inline-block w-2 h-2 rounded-full bg-fg-muted" />;
}

/** "11m 58s" while working; "3m 36s · 5 steps" once done. Static (no ticker):
 *  the popup is glanced at, and a live counter here would just be noise. */
function rowStatus(run: SpecialistRunView): string {
  const end = run.endedAt ?? Date.now();
  const elapsed = formatElapsed(Math.max(0, end - run.startedAt));
  const steps = run.steps !== undefined ? ` · ${run.steps} step${run.steps === 1 ? '' : 's'}` : '';
  if (run.status === 'running') return `${elapsed}${run.stale ? ' · may be stuck' : ''}`;
  if (run.status === 'interrupted') return `stopped after ${elapsed}${steps}`;
  if (run.status === 'failed') return `failed after ${elapsed}${steps}`;
  return `${elapsed}${steps}`;
}

function Row({ row, sessionId, onJump }: { row: HelperRow; sessionId?: string; onJump: () => void }) {
  const run = row.run;
  const first = run?.title.split(' ')[0];
  const done = row.group === 'finished';
  return (
    <div className={`group px-2 py-1.5 rounded ${done ? 'opacity-60' : ''}`} data-testid={`helper-row-${row.key}`}>
      <div className="flex gap-2 items-start">
        <div className="pt-1.5"><StatusDot group={row.group} stale={run?.stale} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            {/* The name IS the link to the card — no separate "Show in chat". */}
            <button
              type="button"
              onClick={() => { jumpToCard(row.parentToolCallId); onJump(); }}
              className="text-xs text-fg hover:underline truncate text-left flex-1 min-w-0"
              title="Show this helper's card in the conversation"
            >
              {run?.title ?? 'A specialist'}
            </button>
            {run && <span className="text-2xs text-fg-muted shrink-0">{rowStatus(run)}</span>}
          </div>
          {run && (
            <div className="text-2xs text-fg-muted mt-0.5 leading-tight truncate">
              <span className="font-mono">{run.agentType}</span>
              {run.description ? ` · ${run.description}` : ''}
            </div>
          )}
          {row.asks.map(segment => {
            const { label, detail } = friendlyToolDisplay({
              toolUseId: segment.toolUseId, toolName: segment.toolName, input: segment.input, status: segment.status,
            });
            return (
              <div key={segment.requestId} className="mt-1.5 space-y-1">
                <div className="text-2xs leading-tight">
                  <span className="text-fg-2">Wants to: {label}</span>
                  {detail && <span className="text-fg-muted"> {detail}</span>}
                </div>
                <SpecialistAskBlock segment={segment} sessionId={sessionId} specialistName={first} compact />
              </div>
            );
          })}
        </div>
        {run && run.status === 'running' && sessionId && (
          // Resting 40% like OpenTasksPopup's row action: a standing hint the
          // row is actionable without shouting.
          <div className="opacity-40 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
            <SpecialistActions sessionId={sessionId} run={run} compact />
          </div>
        )}
      </div>
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
