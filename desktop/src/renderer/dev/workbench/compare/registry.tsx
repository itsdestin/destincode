// src/renderer/dev/workbench/compare/registry.tsx
//
// The authored candidate sets for the comparison view. THIS is the file Claude
// edits between rounds; CompareView.tsx is the harness and shouldn't need to
// change to add a comparison.
//
// ── The rule that keeps this honest ──────────────────────────────────────────
// Candidates are built from the REAL primitives and the REAL tokens — Button,
// Toggle, TagChip, fieldClasses, bg-inset, text-3xs. Never redraw a control by
// hand "close enough". The whole reason this lives in the app rather than in a
// static mockup is that the winner should paste into the production component
// and look identical, and that only holds if the pieces were already the
// production pieces.
//
// What IS new code here is the ARRANGEMENT under comparison, and only that.
// A candidate that reimplements a Toggle is a bug in the candidate.
//
// ── Adding a round ───────────────────────────────────────────────────────────
// Append a Round to the surface's `rounds` array with `basis` naming what it
// came from. The view picks up the new round on HMR and advances to it once the
// previous round has a recorded pick. Don't delete old rounds — the breadcrumb
// IS the record of how a design got where it did.
import React from 'react';
import { Button, Toggle } from '../../../components/ui';
import { TagChip } from '../../../components/tags/TagChip';
import { PRIORITY_TAG } from '../../../components/tags/built-in-tags';
import type { CompareSurface } from './types';

const WORK_TAG = { label: 'work', color: 'tag-blue' } as const;
const NOTE = 'blocked on the gh dead-end';

/** The check-in-a-circle used by the Resume Browser card and the close prompt.
 *  Duplicated here rather than imported because it is a private helper of
 *  CloseSessionPrompt — if a candidate wins and that changes, export it and
 *  delete this. */
function CompleteGlyph({ done, className = '' }: { done: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
      <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
    </svg>
  );
}

// ── Close-session prompt: the collapsed summary row ──────────────────────────
// Round 1 seeds the view with a question that is genuinely open rather than a
// demo: the summary landed on 2026-07-31 and has not been reviewed. It is the
// first thing you see when closing a session, so it sets the tone for a dialog
// most people will use without reading.

function SummaryCard() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-1">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

function SummaryLabelled() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags &amp; note</label>
          <button type="button" className="text-3xs text-fg-muted hover:text-fg transition-colors">Edit</button>
        </div>
        {/* No card at all — the chips sit directly on the dialog, the way the
            Resume Browser card's own chip line does. One less box. */}
        <div className="flex flex-wrap items-center gap-1">
          <TagChip tag={PRIORITY_TAG} />
          <TagChip tag={WORK_TAG} />
        </div>
        <p className="text-2xs text-fg-2 truncate">{NOTE}</p>
      </div>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

function SummaryMerged() {
  const [done, setDone] = React.useState(false);
  // One box for both jobs: the filing summary and the complete decision live in
  // a single bordered group, so the dialog body is one object instead of two.
  return (
    <div className="rounded-lg border border-edge-dim bg-inset divide-y divide-edge-dim">
      <button type="button" className="group w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors hover:bg-well">
        <span className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-1">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <div className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-well">
        <CompleteGlyph done={done} className={`w-5 h-5 shrink-0 transition-colors ${done ? 'text-accent' : 'text-fg-faint'}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg">Mark complete</span>
          <span className="block text-3xs text-fg-muted leading-snug">Hides it from the resume list unless you turn on Show Complete.</span>
        </span>
        <Toggle checked={done} onChange={setDone} aria-label="Mark complete" />
      </div>
    </div>
  );
}

/** The shipped Mark-complete row, shared by the candidates that keep it separate. */
function CompleteRow({ done, onChange }: { done: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge-dim bg-inset px-3 py-2.5 transition-colors hover:border-edge hover:bg-well">
      <CompleteGlyph done={done} className={`w-5 h-5 shrink-0 transition-colors ${done ? 'text-accent' : 'text-fg-faint'}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-fg">Mark complete</span>
        <span className="block text-3xs text-fg-muted leading-snug">Hides it from the resume list unless you turn on Show Complete.</span>
      </span>
      <Toggle checked={done} onChange={onChange} aria-label="Mark complete" />
    </div>
  );
}

/** Dialog chrome around a candidate, so the body is judged at its real width
 *  with the real header and footer either side of it. */
function InDialog({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Close session</h2>
        <p className="text-2xs text-fg-muted mt-1 truncate">fix chat scroll stick</p>
      </div>
      <div className="px-4 py-4">{children}</div>
      <div className="px-4 pb-4 flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm">Cancel</Button>
        <Button size="sm">Close session</Button>
      </div>
    </div>
  );
}

export const COMPARE_SURFACES: CompareSurface[] = [
  {
    id: 'close-prompt-body',
    label: 'Close session — body',
    question: 'How should the collapsed tags/note summary and Mark complete sit together?',
    frame: 'panel',
    paneWidth: 380,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'card',
            label: 'Card + row',
            note: 'Shipped today. Two bordered boxes stacked; the summary is a card, Mark complete is its own row.',
            render: () => <InDialog><SummaryCard /></InDialog>,
          },
          {
            id: 'labelled',
            label: 'Labelled, no card',
            note: 'Summary loses its box — chips sit directly on the dialog under a section label, like the Resume Browser card does.',
            render: () => <InDialog><SummaryLabelled /></InDialog>,
          },
          {
            id: 'merged',
            label: 'One grouped box',
            note: 'Both jobs share one bordered group split by a divider, so the dialog body reads as a single object.',
            render: () => <InDialog><SummaryMerged /></InDialog>,
          },
        ],
      },
    ],
  },
];
