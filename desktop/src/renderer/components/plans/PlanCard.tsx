import { useEffect, useState } from 'react';
import type { PlanView, PlanStepView, SpecialistRunView } from '../../../shared/types';
import { useChatDispatch } from '../../state/chat-context';
import { Button, Textarea, TextInput } from '../ui';
import { CheckIcon, FailIcon, StoppedIcon, ChevronIcon } from '../Icons';
import BrailleSpinner from '../BrailleSpinner';
import { SpecialistActions } from '../specialists/SpecialistActions';
import { RunStatusLine, formatElapsed } from '../specialists/RunStatusLine';
import { asString } from '../../utils/tool-input';

/**
 * Specialists stage two — the PLAN CARD (design mockup, 2026-09-05; no backend
 * yet, every `window.claude.plans.*` call below is a MOCK_ONLY channel).
 *
 * What Destin decided on the 2026-09-05 questions deck, and what each answer
 * pins here:
 *  Q-2  Before approval the card is a short step list, the specialist count,
 *       ONE ceiling line, then Approve and Comment. Detail folds per step.
 *  Q-3  Comment opens a note box under the card; the assistant rewrites the
 *       plan and posts a NEW card, and this one greys out ("revised").
 *  Q-4  Auto-approve is off until the user turns it on in Settings; a plan
 *       that ran without asking says so on the card, ceiling still printed.
 *  Q-5  The plan card IS the progress surface: steps tick off, each running
 *       specialist is a line inside its step with Note / Stop.
 *  Q-6  A plan that hits its ceiling pauses IN PLACE: finished work stays,
 *       the stuck step says why, Add budget / Stop.
 *  Q-7  After a restart the card comes back "Interrupted — 3 of 5 done" with
 *       Continue; nothing runs until it is pressed.
 * Settled by the spec (§4), not up for re-derivation: budgets are hard stops,
 * the ceiling is Σ(step cap × fan-out) priced per model, dollars appear only
 * when the model has a published price — tokens always do.
 */

// ---- header (ToolCard's friendlyToolDisplay reads these) --------------------

/** "Plan: <goal>" plus the one status phrase the header can carry. */
export function planDisplay(input: Record<string, unknown>, plan?: PlanView): { label: string; detail: string } {
  const title = plan?.title || asString(input.title) || 'a plan';
  const label = `Plan: ${title}`;
  if (!plan) return { label, detail: '' };
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const detail =
    plan.status === 'writing' ? 'writing the plan…'
    : plan.status === 'proposed' ? 'waiting for your approval'
    : plan.status === 'running' ? `step ${Math.min(done + 1, total)} of ${total}`
    : plan.status === 'paused' ? 'paused — reached its limit'
    : plan.status === 'interrupted' ? `interrupted — ${done} of ${total} steps done`
    : plan.status === 'completed' ? `finished in ${formatElapsed((plan.endedAt ?? 0) - (plan.startedAt ?? 0))}`
    : plan.status === 'stopped' ? (plan.revisedBy ? 'revised — see the new plan below' : `stopped — ${done} of ${total} steps done`)
    : 'failed';
  return { label, detail };
}

/** The header glyph. A proposed plan wears the question mark every ask wears. */
export function planIcon(plan: PlanView): 'spinner' | 'check' | 'fail' | 'stopped' | 'question' | 'paused' {
  switch (plan.status) {
    case 'writing': case 'running': return 'spinner';
    case 'proposed': return 'question';
    case 'completed': return 'check';
    case 'failed': return 'fail';
    // Paused and interrupted are WAITING states, not endings: the same glyph
    // as stopped but without the header's "stopped" tag, which would say the
    // plan is over when Add budget / Continue are right there.
    case 'paused': case 'interrupted': return 'paused';
    default: return 'stopped';
  }
}

// ---- numbers -----------------------------------------------------------------

function tokens(n: number): string { return `${n.toLocaleString()} tokens`; }

/** "$0.12"; "less than a cent" rather than a false "$0.00" (error-message
 *  standard: never print a zero that is not one). */
function usd(n: number): string {
  if (n > 0 && n < 0.005) return 'less than a cent';
  return `$${n.toFixed(2)}`;
}

/** The ceiling, priced when the model has a price. */
function ceiling(plan: PlanView): string {
  const base = `Up to ${tokens(plan.ceilingTokens)}`;
  return plan.ceilingUsd == null
    ? `${base} on ${plan.model.label} · no published price`
    : `${base} · about ${usd(plan.ceilingUsd)} on ${plan.model.label}`;
}

function spent(plan: PlanView): string {
  const t = tokens(plan.usedTokens ?? 0);
  return plan.usedUsd == null ? t : `${t} · ${usd(plan.usedUsd)}`;
}

// ---- the block ---------------------------------------------------------------

export function PlanBlock({ plan, sessionId }: { plan: PlanView; sessionId?: string }) {
  const dispatch = useChatDispatch();
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [adding, setAdding] = useState(false);
  const [extra, setExtra] = useState('10000');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revised = plan.status === 'stopped' && !!plan.revisedBy;

  // Every button goes through one mock call and lands the returned record the
  // way the real push will — so the card never invents a state on its own.
  const act = async (name: string, fn: () => Promise<{ ok: true; plan: PlanView } | { ok: false; error: string }>) => {
    if (!sessionId) return;
    setBusy(name); setError(null);
    try {
      const res = await fn();
      if (res.ok) dispatch({ type: 'PLAN_CHANGED', sessionId, plan: res.plan });
      else setError(res.error);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const plans = () => (window as any).claude?.plans;
  const approve = () => act('approve', () => plans().approve(sessionId, plan.planId));
  const sendComment = () => act('comment', () => plans().comment(sessionId, plan.planId, comment.trim())).then(() => { setComment(''); setCommenting(false); });
  const addBudget = () => act('budget', () => plans().addBudget(sessionId, plan.planId, Number(extra) || 0)).then(() => setAdding(false));
  const cont = () => act('continue', () => plans().resume(sessionId, plan.planId));
  const stop = () => act('stop', () => plans().stop(sessionId, plan.planId));

  const specialists = plan.steps.reduce((n, s) => n + s.fanOut, 0);
  const done = plan.steps.filter((s) => s.status === 'done').length;

  return (
    <div className={`px-3 pb-2.5 pt-1.5 space-y-2 ${revised ? 'opacity-60' : ''}`} data-testid="plan-block" data-plan-status={plan.status}>
      {plan.status === 'writing' ? (
        <WritingLine plan={plan} />
      ) : (
        <>
          <ol className="space-y-1" data-testid="plan-steps">
            {plan.steps.map((step, i) => (
              <StepRow key={step.id} step={step} index={i} plan={plan} sessionId={sessionId} />
            ))}
          </ol>

          {/* ONE ceiling line (Q-2). While the plan moves it becomes "used of up to". */}
          <div className="text-xs text-fg-dim" data-testid="plan-ceiling">
            {plan.status === 'proposed'
              ? <>{specialists} specialist{specialists === 1 ? '' : 's'} · {ceiling(plan)}</>
              : plan.status === 'completed'
                ? <>Finished in {formatElapsed((plan.endedAt ?? 0) - (plan.startedAt ?? 0))} · used {spent(plan)} of up to {tokens(plan.ceilingTokens)}</>
                : <>Used {spent(plan)} of up to {tokens(plan.ceilingTokens)}{plan.ceilingUsd != null ? ` (about ${usd(plan.ceilingUsd)})` : ''}</>}
          </div>

          {plan.autoApproved && (
            <div className="text-2xs text-fg-muted">Ran without asking — under the limit you set in Settings.</div>
          )}

          {plan.status === 'paused' && plan.paused && (
            // Amber: the same tone the held-ask and stale-run lines use — a
            // stop that needs a person, not an error.
            <div className="text-xs text-amber-500" data-testid="plan-paused-reason">
              Paused — {plan.paused.reason} Nothing is spent past the ceiling you approved.
            </div>
          )}

          {plan.status === 'interrupted' && (
            <div className="text-xs text-fg-dim" data-testid="plan-interrupted-note">
              The app closed while this plan was running. {done} of {plan.steps.length} steps finished and their results are kept; Continue runs only what is left.
            </div>
          )}

          {revised && (
            <div className="text-2xs text-fg-muted">Revised after your comment — the new plan is below.</div>
          )}

          {/* Buttons per state. Primary = the thing that moves the plan; Stop
              is always ghost so it never reads as the default. */}
          {plan.status === 'proposed' && !commenting && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="primary" onClick={approve} disabled={busy !== null}>{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>
              <Button size="sm" variant="secondary" onClick={() => setCommenting(true)} disabled={busy !== null}>Comment</Button>
            </div>
          )}
          {plan.status === 'proposed' && commenting && (
            <div className="space-y-1.5" data-testid="plan-comment">
              <Textarea
                size="sm"
                rows={2}
                className="w-full"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (comment.trim()) void sendComment(); } }}
                placeholder="What should change? The assistant rewrites the plan and shows you a new one."
                autoFocus
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={sendComment} disabled={busy !== null || !comment.trim()}>{busy === 'comment' ? 'Sending…' : 'Send'}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setCommenting(false); setComment(''); }} disabled={busy !== null}>Cancel</Button>
              </div>
            </div>
          )}
          {plan.status === 'running' && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={stop} disabled={busy !== null}>{busy === 'stop' ? 'Stopping…' : 'Stop the plan'}</Button>
            </div>
          )}
          {plan.status === 'paused' && !adding && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={busy !== null}>Add budget</Button>
              <Button size="sm" variant="ghost" onClick={stop} disabled={busy !== null}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
            </div>
          )}
          {plan.status === 'paused' && adding && (
            <div className="flex items-center gap-2 flex-wrap" data-testid="plan-add-budget">
              <span className="text-xs text-fg-dim">Allow</span>
              <TextInput size="sm" inputMode="numeric" value={extra} onChange={(e) => setExtra(e.target.value.replace(/[^0-9]/g, ''))} className="w-24" aria-label="More tokens to allow" />
              <span className="text-xs text-fg-dim">more tokens{plan.ceilingUsd != null && plan.ceilingTokens > 0 ? ` (about ${usd((Number(extra) || 0) * (plan.ceilingUsd / plan.ceilingTokens))})` : ''}</span>
              <Button size="sm" variant="primary" onClick={addBudget} disabled={busy !== null || !(Number(extra) > 0)}>{busy === 'budget' ? 'Continuing…' : 'Continue'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy !== null}>Cancel</Button>
            </div>
          )}
          {plan.status === 'interrupted' && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="primary" onClick={cont} disabled={busy !== null}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
              <Button size="sm" variant="ghost" onClick={stop} disabled={busy !== null}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
            </div>
          )}
          {error && <div className="text-xs text-destructive-fg">{error}</div>}
        </>
      )}
    </div>
  );
}

/** "Writing the plan… 1m 12s" — a visible state, not a spinner that looks
 *  hung: a local model reasons for 40 s to 4 min before it writes (probe 3). */
function WritingLine({ plan }: { plan: PlanView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const elapsed = formatElapsed(Math.max(0, now - (plan.startedAt ?? now)));
  return (
    <div className="text-xs text-fg-dim" data-testid="plan-writing">
      Writing the plan · {elapsed}. The assistant thinks through the steps before it writes them — on a model running on your computer this can take a few minutes.
    </div>
  );
}

const STEP_GLYPH: Record<PlanStepView['status'], React.ReactNode> = {
  pending: <span className="inline-block w-3.5 h-3.5 rounded-full border border-edge" aria-label="not started" />,
  running: <BrailleSpinner size="sm" />,
  done: <CheckIcon className="w-3.5 h-3.5 text-fg-dim" />,
  paused: <StoppedIcon className="w-3.5 h-3.5 text-amber-500" />,
  failed: <FailIcon className="w-3.5 h-3.5 text-destructive-fg" />,
  skipped: <StoppedIcon className="w-3.5 h-3.5 text-fg-muted" />,
};

const KIND_WORD: Record<PlanStepView['kind'], string> = {
  map: 'in parallel',
  verify: 'checks each result',
  combine: 'combines the results',
  repeat: 'repeats until done',
};

function StepRow({ step, index, plan, sessionId }: { step: PlanStepView; index: number; plan: PlanView; sessionId?: string }) {
  // A running step opens itself so its specialists are visible without a
  // click (Q-5: the card is the progress surface); anything else folds.
  const [open, setOpen] = useState(step.status === 'running' || step.status === 'paused');
  useEffect(() => { if (step.status === 'running' || step.status === 'paused') setOpen(true); }, [step.status]);
  const who = `${step.fanOut} ${step.specialist}${step.fanOut === 1 ? '' : 's'}`;
  const right =
    step.status === 'pending' || plan.status === 'proposed' ? `up to ${tokens(step.budgetTokens * step.fanOut)}`
    : step.status === 'running' || step.status === 'paused' ? `${step.done ?? 0} of ${step.fanOut} done · ${tokens(step.usedTokens ?? 0)}`
    : step.status === 'done' ? tokens(step.usedTokens ?? 0)
    : '';
  return (
    <li data-testid={`plan-step-${step.id}`} data-step-status={step.status}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-2 text-left rounded-md px-1 py-0.5 hover:bg-inset/50 transition-colors">
        <span className="shrink-0 inline-flex w-3.5 justify-center">{STEP_GLYPH[step.status]}</span>
        <span className="text-xs text-fg-muted tabular-nums shrink-0">{index + 1}.</span>
        <span className={`text-xs ${step.status === 'done' ? 'text-fg-dim' : 'text-fg-2'} truncate`}>{step.title}</span>
        <span className="text-2xs text-fg-muted truncate">{who} · {KIND_WORD[step.kind]}</span>
        <span className="ml-auto text-2xs text-fg-muted tabular-nums shrink-0">{right}</span>
        <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0" expanded={open} />
      </button>
      {open && (
        <div className="ml-7 mt-1 space-y-1">
          {step.children && step.children.length > 0 ? (
            step.children.map((c) => <ChildLine key={c.childId} run={c} sessionId={sessionId} />)
          ) : (
            <div className="text-2xs text-fg-muted">
              Each {step.specialist} gets up to {tokens(step.budgetTokens)}; that cap is enforced, not estimated.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** One specialist inside a step: name, its status line, Note / Stop while it runs. */
function ChildLine({ run, sessionId }: { run: SpecialistRunView; sessionId?: string }) {
  return (
    <div className="flex items-start gap-2 flex-wrap" data-testid="plan-child">
      <span className="text-xs text-fg-2 shrink-0">{run.title}</span>
      <div className="min-w-0"><RunStatusLine run={run} /></div>
      {run.status === 'running' && sessionId && (
        <div className="basis-full"><SpecialistActions sessionId={sessionId} run={run} compact /></div>
      )}
    </div>
  );
}
