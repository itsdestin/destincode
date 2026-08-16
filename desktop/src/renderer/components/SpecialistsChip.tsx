import { useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { useSpecialistSummary, useSpecialistRoster, type SpecialistSummary, type HelperView } from '../hooks/useSpecialists';
import { SpecialistAskBlock } from './specialists/SpecialistAskBlock';
import { SpecialistActions } from './specialists/SpecialistActions';
import { formatElapsed } from './specialists/RunStatusLine';
import { friendlyToolDisplay } from './ToolCard';
import { Dialog } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { CheckIcon, FailIcon, QuestionIcon, StoppedIcon } from './Icons';

/**
 * Specialists 1c — the status-bar chip (spec §6 "attention, not vigilance")
 * and the management popup behind it (Destin, round 1: an ask buried inside a
 * Task card is impossible to navigate — the card still shows it, but THIS is
 * where a session's helpers are managed).
 *
 * Round 4 (Destin: "cards with clear hierarchy, useful and intuitive"): one
 * card per helper, top to bottom in the order a person asks the questions —
 * WHO (name, role, what it may do, model) → WHAT (the job) → HOW FAR (elapsed,
 * steps, the tool it is on right now, the last few things it did) → WHAT IT
 * NEEDS (the ask, tinted, with the real buttons) → WHAT YOU CAN DO (note /
 * stop / show in chat). Finished cards swap the progress strip for a report
 * preview. Grouped Needs you → Working → Finished.
 */
export default function SpecialistsChip({ sessionId }: { sessionId: string | null | undefined }) {
  const summary = useSpecialistSummary(sessionId ?? undefined);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  if (summary.helpers.length === 0) return null;

  const { needsYou, working, finished } = summary;
  const label = needsYou > 0
    ? `${needsYou} need${needsYou === 1 ? 's' : ''} you`
    : working > 0
      ? `${working} specialist${working === 1 ? '' : 's'}`
      : `${finished} finished`;
  const tooltip = needsYou > 0
    ? `${needsYou} specialist ask${needsYou === 1 ? '' : 's'} waiting on you — click to answer`
    : working > 0
      ? `${working} specialist${working === 1 ? '' : 's'} working — click to manage`
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
        {needsYou > 0 ? <QuestionIcon className="w-3 h-3" /> : working > 0 ? <BrailleSpinner size="xs" /> : <CheckIcon className="w-3 h-3" />}
        <span>{label}</span>
      </button>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Specialists"
          subtitle={[
            needsYou > 0 ? `${needsYou} waiting on you` : null,
            working > 0 ? `${working} working` : null,
            finished > 0 ? `${finished} finished` : null,
          ].filter(Boolean).join(' · ')}
          size="document"
        >
          <SpecialistManager summary={summary} sessionId={sessionId ?? undefined} onJump={() => setOpen(false)} />
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase px-1 pt-1 pb-1.5';

function SpecialistManager({ summary, sessionId, onJump }: { summary: SpecialistSummary; sessionId?: string; onJump: () => void }) {
  const roster = useSpecialistRoster();
  const groups: Array<{ id: HelperView['group']; label: string }> = [
    { id: 'needs-you', label: 'Needs you' },
    { id: 'working', label: 'Working' },
    { id: 'finished', label: 'Finished' },
  ];
  return (
    <div className="space-y-4">
      {groups.map(g => {
        const items = summary.helpers.filter(h => h.group === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id}>
            <h3 className={SECTION_LABEL}>{g.label}</h3>
            <div className="space-y-2">
              {items.map(h => (
                <HelperCard
                  key={h.run.childId}
                  h={h}
                  sessionId={sessionId}
                  charter={roster?.find(d => d.id === h.run.agentType)?.charter}
                  canShell={roster?.find(d => d.id === h.run.agentType)?.allowedTools.includes('Bash') ?? false}
                  onJump={onJump}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Status pill — the one word that answers "what state is this helper in". */
function StatusPill({ h }: { h: HelperView }) {
  const base = 'inline-flex items-center gap-1 text-3xs font-medium px-1.5 py-0.5 rounded-full border';
  if (h.group === 'needs-you') return <span className={`${base} border-amber-500/40 text-amber-500 bg-amber-500/10`}><QuestionIcon className="w-3 h-3" />Needs you</span>;
  if (h.run.status === 'running') return <span className={`${base} border-blue-400/40 text-blue-400 bg-blue-400/10`}><BrailleSpinner size="xs" />{h.run.stale ? 'May be stuck' : 'Working'}</span>;
  if (h.run.status === 'interrupted') return <span className={`${base} border-edge text-fg-muted`}><StoppedIcon className="w-3 h-3" />Stopped</span>;
  if (h.run.status === 'failed' || h.report?.status === 'failed') return <span className={`${base} border-danger/40 text-danger bg-danger/10`}><FailIcon className="w-3 h-3" />Failed</span>;
  return <span className={`${base} border-edge text-fg-muted`}><CheckIcon className="w-3 h-3" />Finished</span>;
}

function HelperCard({ h, sessionId, charter, canShell, onJump }: {
  h: HelperView; sessionId?: string; charter?: 'read-only' | 'read-write'; canShell: boolean; onJump: () => void;
}) {
  const { run } = h;
  const first = run.title.split(' ')[0];
  const done = h.group === 'finished';
  const elapsed = formatElapsed(Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt));
  const steps = run.steps ?? h.toolCalls;
  const jump = () => { jumpToCard(h.parentToolCallId); onJump(); };
  const attention = h.group === 'needs-you';

  return (
    <div
      className={`rounded-lg border ${attention ? 'border-amber-500/40' : 'border-edge'} bg-inset/50 overflow-hidden ${done ? 'opacity-80' : ''}`}
      data-testid={`helper-card-${run.childId}`}
    >
      {/* ── WHO ─────────────────────────────────────────────────────────── */}
      <div className="px-3 pt-2.5 pb-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <button type="button" onClick={jump} className="text-sm font-semibold text-fg hover:underline text-left truncate block max-w-full" title="Show this helper's card in the conversation">
              {run.title}
            </button>
            {/* One wrapping line, separators inline with the text (a flex-gap
                version left a dangling "·" at a wrap). */}
            <div className="mt-0.5 text-2xs text-fg-muted leading-snug">
              <span className="font-mono uppercase tracking-wide">{run.agentType}</span>
              {charter && <>{' · '}<span className={charter === 'read-write' ? 'text-amber-500' : ''}>
                {charter === 'read-write' ? (canShell ? 'can edit & run commands' : 'can edit files') : 'read-only'}
              </span></>}
              {run.model ? ` · on ${run.model.label}` : ''}
              {run.background && run.status === 'running' ? ' · in the background' : ''}
            </div>
          </div>
          <StatusPill h={h} />
        </div>
        {/* ── WHAT ─────────────────────────────────────────────────────── */}
        {run.description && <div className="mt-1.5 text-xs text-fg-2">{run.description}</div>}
      </div>

      {/* ── HOW FAR ──────────────────────────────────────────────────────── */}
      {!done && (
        <div className="border-t border-edge-dim px-3 py-2">
          <div className="flex items-center gap-2 text-2xs text-fg-muted">
            <span className="text-fg-dim">{elapsed}</span>
            <span aria-hidden>·</span>
            <span>{steps} step{steps === 1 ? '' : 's'}</span>
            {h.current && !attention && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate min-w-0">now: {friendlyToolDisplay(segToTool(h.current)).label}</span>
              </>
            )}
          </div>
          {h.recent.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {h.recent.map(seg => {
                const { label, detail } = friendlyToolDisplay(segToTool(seg));
                return (
                  <li key={seg.id} className="flex items-center gap-1.5 text-2xs min-w-0">
                    <span className="shrink-0 inline-flex text-fg-muted">
                      {seg.status === 'running' ? <BrailleSpinner size="xs" />
                        : seg.status === 'awaiting-approval' ? <QuestionIcon className="w-3 h-3 text-amber-500" />
                        : seg.status === 'failed' ? <FailIcon className="w-3 h-3" />
                        : <CheckIcon className="w-3 h-3" />}
                    </span>
                    <span className="text-fg-dim shrink-0">{label}</span>
                    {detail && <span className="text-fg-muted truncate min-w-0">{detail}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ── WHAT IT NEEDS ────────────────────────────────────────────────── */}
      {h.asks.map(seg => {
        const { label } = friendlyToolDisplay(segToTool(seg));
        // The exact thing being approved, in full — a command, a path, a URL —
        // not the card's abbreviated "↳ cache/" detail.
        const subject = askSubject(seg.input);
        return (
          <div key={seg.requestId} className="border-t border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 space-y-1.5" data-testid="helper-card-ask">
            <div className="text-xs">
              <span className="font-medium text-fg">{first} wants to: </span>
              <span className="text-fg-2">{label}</span>
            </div>
            {subject && <div className="text-2xs font-mono text-fg-dim break-all">{subject}</div>}
            <SpecialistAskBlock segment={seg} sessionId={sessionId} specialistName={first} compact />
          </div>
        );
      })}

      {/* ── THE REPORT (finished) ─────────────────────────────────────────── */}
      {done && (
        <div className="border-t border-edge-dim px-3 py-2">
          <div className="text-2xs text-fg-muted mb-1">
            {run.status === 'interrupted' ? `Stopped after ${elapsed}` : run.status === 'failed' || h.report?.status === 'failed' ? `Failed after ${elapsed}` : `Finished in ${elapsed}`}
            {' · '}{steps} step{steps === 1 ? '' : 's'}
          </div>
          {h.report ? (
            // Plain-text teaser, not rendered markdown: a table or heading
            // rendered at full size inside a 3-line clip looked broken. The
            // real report, formatted, is on the card one click away.
            <p className="text-xs text-fg-dim leading-snug line-clamp-3">{reportPreview(h.report.text)}</p>
          ) : (
            <div className="text-2xs text-fg-muted italic">No report — the assistant can pick this back up.</div>
          )}
        </div>
      )}

      {/* ── WHAT YOU CAN DO ──────────────────────────────────────────────── */}
      <div className="border-t border-edge-dim px-3 py-1.5 flex items-center gap-2">
        {run.status === 'running' && sessionId
          ? <SpecialistActions sessionId={sessionId} run={run} compact />
          : <span className="text-2xs text-fg-muted">{done && h.report ? 'Full report is on the card.' : ''}</span>}
        <button type="button" onClick={jump} className="ml-auto text-2xs text-fg-muted hover:text-fg-2 shrink-0">
          Show in chat ↗
        </button>
      </div>
    </div>
  );
}

function askSubject(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function segToTool(seg: HelperView['recent'][number]) {
  return { toolUseId: seg.toolUseId, toolName: seg.toolName, input: seg.input, status: seg.status };
}

/** A plain-text teaser of the report body: framing the card header already
 *  states is dropped, markdown is flattened (headings, emphasis, table pipes,
 *  links → their text), whitespace collapsed. ~3 lines; the card has the rest. */
function reportPreview(text: string): string {
  let t = text;
  if (/^\[Background specialist/.test(t)) { const i = t.indexOf('\n\n'); t = i === -1 ? t : t.slice(i + 2); }
  t = t.replace(/^## Report from [^\n]*\n+/, '').replace(/\n*\[specialist session [^\]]+\]\s*$/, '');
  t = t
    .replace(/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')   // table rules
    .replace(/^#{1,6}\s+/gm, '')                                     // headings
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                        // links → text
    .replace(/[*_`]+/g, '')                                          // emphasis / code ticks
    .replace(/\s*\|\s*/g, ' · ')                                     // table cells
    .replace(/(\s*·\s*){2,}/g, ' · ')                                // collapse doubled separators
    .replace(/\s+/g, ' ')
    .replace(/^(\s*·\s*)+/, '')
    .trim();
  return t.length > 320 ? `${t.slice(0, 320)}…` : t;
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
