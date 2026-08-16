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
  const running = run.status === 'running';
  const elapsed = formatElapsed(Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt));
  const steps = run.steps ?? h.toolCalls;
  const jump = () => { jumpToCard(h.parentToolCallId); onJump(); };
  const attention = h.group === 'needs-you';

  // Row 2 — everything about the run in one muted line. Order: identity facts
  // (fixed) → progress facts (moving) → what it is doing right now.
  const meta: string[] = [run.agentType.toUpperCase()];
  if (charter) meta.push(charter === 'read-write' ? (canShell ? 'can edit & run commands' : 'can edit files') : 'read-only');
  // The model only when it is NOT simply the conversation's own — that is the
  // default and saying it on every card is noise.
  if (run.model && run.model.via && run.model.via !== 'parent') meta.push(`on ${run.model.label}`);
  if (run.background && running) meta.push('background');
  if (running) meta.push(elapsed, `${steps} step${steps === 1 ? '' : 's'}`);
  else meta.push(
    run.status === 'interrupted' ? `stopped after ${elapsed}` : (run.status === 'failed' || h.report?.status === 'failed') ? `failed after ${elapsed}` : `finished in ${elapsed}`,
    `${steps} step${steps === 1 ? '' : 's'}`,
  );
  if (running && h.current && !attention) meta.push(`now: ${friendlyToolDisplay(segToTool(h.current)).label}`);
  if (running && run.stale) meta.push('may be stuck');

  const actions = running && sessionId ? <SpecialistActions sessionId={sessionId} run={run} compact /> : null;

  return (
    <div
      className={`rounded-lg border ${attention ? 'border-amber-500/40' : 'border-edge'} bg-inset/50 overflow-hidden ${done ? 'opacity-80' : ''}`}
      data-testid={`helper-card-${run.childId}`}
    >
      <div className="px-3 py-2 space-y-0.5">
        {/* Row 1 — who and what, status at the right, ↗ to the card. */}
        <div className="flex items-baseline gap-2 min-w-0">
          <button type="button" onClick={jump} className="text-sm font-semibold text-fg hover:underline text-left shrink-0" title="Show this helper's card in the conversation">
            {run.title}
          </button>
          {run.description && <span className="text-xs text-fg-2 truncate min-w-0 flex-1">— {run.description}</span>}
          <span className="ml-auto shrink-0 flex items-center gap-1.5">
            <StatusPill h={h} />
            <button type="button" onClick={jump} className="text-fg-muted hover:text-fg-2 text-xs leading-none" title="Show in chat" aria-label="Show in chat">↗</button>
          </span>
        </div>
        {/* Row 2 — the run in one line; Note / Stop live here when there is
            no ask (with an ask they sit on the button row below instead). */}
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="text-2xs text-fg-muted leading-snug min-w-0 flex-1">
            {meta.map((m, i) => (
              <span key={i} className={m === 'may be stuck' ? 'text-amber-500' : (m.startsWith('can edit') ? 'text-amber-500' : '')}>
                {i > 0 ? ' · ' : ''}{m}
              </span>
            ))}
          </div>
          {!attention && actions && <div className="shrink-0">{actions}</div>}
        </div>
        {/* Finished — a two-line teaser; the formatted report is on the card. */}
        {done && h.report && (
          <p className="text-2xs text-fg-dim leading-snug line-clamp-2 pt-0.5">{reportPreview(h.report.text)}</p>
        )}
        {done && !h.report && run.status === 'interrupted' && (
          <p className="text-2xs text-fg-muted italic pt-0.5">No report — the assistant can pick this back up.</p>
        )}
      </div>

      {/* Ask band — what exactly it wants, then the buttons with Note / Stop
          on the same line. */}
      {h.asks.map((seg, i) => {
        const { label } = friendlyToolDisplay(segToTool(seg));
        const subject = askSubject(seg.input);
        return (
          <div key={seg.requestId} className="border-t border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 space-y-1.5" data-testid="helper-card-ask">
            <div className="text-xs leading-snug min-w-0">
              <span className="font-medium text-fg">{first} wants to: </span>
              <span className="text-fg-2">{label}</span>
              {subject && subject !== label && <span className="font-mono text-2xs text-fg-dim break-all"> — {subject}</span>}
            </div>
            <SpecialistAskBlock
              segment={seg}
              sessionId={sessionId}
              specialistName={first}
              compact
              trailing={i === h.asks.length - 1 ? actions : undefined}
            />
          </div>
        );
      })}
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
