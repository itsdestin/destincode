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

// ── Round 2: the summary card's internals ────────────────────────────────────
// A won round 1, so the structure is settled: a summary card with the Mark
// complete row separate beneath it. What is still open is how the card ORGANISES
// what it holds — chips, note, and the way in.
//
// All three keep CompleteRow identical below them, so the only difference on
// screen is the thing being compared.

/** Icon-led. A tag glyph and a note glyph stand in for labels, matching the
 *  Resume Browser card's bottom line, which already uses a folder and a layers
 *  glyph the same way. Empty state: one muted "No tags or note" line, no icons. */
function CardIconRows() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 min-w-0">
            <TagGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
            <span className="flex flex-wrap items-center gap-1 min-w-0">
              <TagChip tag={PRIORITY_TAG} />
              <TagChip tag={WORK_TAG} />
            </span>
          </span>
          <span className="flex items-center gap-1.5 min-w-0">
            <NoteGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
            <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
          </span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Labelled sections inside the card — the same uppercase micro-labels the rest
 *  of the app's forms use. Most explicit and most scannable; also the tallest,
 *  and it repeats a vocabulary the chips already carry. Empty state: the labels
 *  stay, each with a muted "None". */
function CardLabelled() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1 flex flex-col gap-2">
            <span className="block">
              <span className="block text-4xs font-medium text-fg-muted tracking-wider uppercase mb-1">Tags</span>
              <span className="flex flex-wrap items-center gap-1">
                <TagChip tag={PRIORITY_TAG} />
                <TagChip tag={WORK_TAG} />
              </span>
            </span>
            <span className="block">
              <span className="block text-4xs font-medium text-fg-muted tracking-wider uppercase mb-1">Note</span>
              <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
            </span>
          </span>
          <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0">Edit</span>
        </span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Note-led. The note is the human sentence you actually wrote; the chips are
 *  filing. So the note takes the top line at full text colour and the chips sit
 *  under it as metadata, which is the inverse of the shipped emphasis. "Edit"
 *  moves to a footer link so the top line starts at the card edge. Empty state:
 *  the footer link becomes the whole affordance ("Add tags or a note"). */
function CardNoteLed() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-2 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="block text-xs text-fg leading-snug line-clamp-2">{NOTE}</span>
        <span className="flex items-center gap-1 flex-wrap">
          <TagChip tag={PRIORITY_TAG} />
          <TagChip tag={WORK_TAG} />
          <span className="ml-auto text-3xs text-fg-muted group-hover:text-fg transition-colors">Edit</span>
        </span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 3: within the icon-led card ────────────────────────────────────────
// Icon-led won round 2, so glyphs-instead-of-labels is settled. What is still
// open is density and alignment: how much vertical space the card takes, where
// the text hangs, and how the way in is drawn.

/** One line. Chips and note share a single truncating row, which makes the card
 *  the same height as the Mark complete row below it — two equal bands instead
 *  of a tall block over a short one. Costs the note its space: anything past a
 *  few words is an ellipsis. Empty: the row reads "No tags or note". */
function CardOneLine() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-center gap-2 transition-colors hover:border-edge hover:bg-well"
      >
        <TagGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
        <span className="flex items-center gap-1 shrink-0">
          <TagChip tag={PRIORITY_TAG} />
          <TagChip tag={WORK_TAG} />
        </span>
        <NoteGlyph className="w-3 h-3 shrink-0 text-fg-muted ml-1" />
        <span className="text-2xs text-fg-2 truncate min-w-0 flex-1">{NOTE}</span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Gutter-aligned. The glyphs sit in a fixed left column so the chips and the
 *  note text start on the SAME left edge — in the round-2 version each row set
 *  its own indent, so they were a pixel or two apart. Edit becomes a pencil in
 *  the corner: the whole card is already the target, so the word was doing
 *  nothing the hover state doesn't. Empty: one gutter row, muted. */
function CardGutter() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group relative w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-1.5 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NoteGlyph className="w-3 h-3 text-fg-muted" />
          <span className="text-2xs text-fg-2 truncate min-w-0">{NOTE}</span>
        </span>
        <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
          <PencilGlyph className="w-3.5 h-3.5" />
        </span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Note as a quotation. Same two rows, but the note gets a left rule and sits
 *  in the muted text colour, so "these are labels I applied" and "this is a
 *  sentence I wrote" separate at a glance rather than on inspection. Tallest of
 *  the three. Empty: the rule disappears with the note. */
function CardQuote() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="min-w-0 flex-1 flex flex-col gap-2">
          <span className="flex items-center gap-1.5 min-w-0">
            <TagGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
            <span className="flex flex-wrap items-center gap-1 min-w-0">
              <TagChip tag={PRIORITY_TAG} />
              <TagChip tag={WORK_TAG} />
            </span>
          </span>
          <span className="block border-l-2 border-edge pl-2 text-2xs text-fg-muted leading-snug line-clamp-2">
            {NOTE}
          </span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Pencil — the edit glyph the app already uses on the tag-manager rows. */
function PencilGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5" />
      <path d="M17.586 3.586a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

/** Mirrored tag glyph — the same one the Resume Browser card uses. */
function TagGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <g transform="translate(24,0) scale(-1,1)">
        <path d="M3 12.5V4.5A1.5 1.5 0 014.5 3h8l8.5 8.5a1.5 1.5 0 010 2.1l-6.9 6.9a1.5 1.5 0 01-2.1 0L3 12.5z" />
        <circle cx="7.75" cy="7.75" r="1.25" />
      </g>
    </svg>
  );
}

/** The notebook glyph the StatusBar tags chip already uses for "has a note". */
function NoteGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
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
      {
        n: 2,
        basis: 'R1 · A (Card + row). Structure settled — a summary card with Mark complete separate beneath it. Open: how the card organises what it holds.',
        candidates: [
          {
            id: 'icon-rows',
            label: 'Icon-led rows',
            note: 'A tag glyph and a note glyph stand in for labels — the same language the Resume Browser card\'s bottom line already uses. Compact, no repeated words.',
            render: () => <InDialog><CardIconRows /></InDialog>,
          },
          {
            id: 'labelled',
            label: 'Labelled sections',
            note: 'Uppercase micro-labels inside the card, matching the rest of the app\'s forms. Most scannable, also the tallest, and it names what the chips already say.',
            render: () => <InDialog><CardLabelled /></InDialog>,
          },
          {
            id: 'note-led',
            label: 'Note first',
            note: 'Inverts the emphasis: the note you actually wrote takes the top line at full text colour, chips demote to metadata under it, and Edit moves inline with them.',
            render: () => <InDialog><CardNoteLed /></InDialog>,
          },
        ],
      },
      {
        n: 3,
        basis: 'R2 · A (Icon-led rows). Glyphs-instead-of-labels settled. Open: density, where the text hangs, and how the way in is drawn.',
        candidates: [
          {
            id: 'one-line',
            label: 'One line',
            note: 'Chips and note share a single truncating row, making the card the same height as Mark complete below it — two equal bands. Costs the note its space.',
            render: () => <InDialog><CardOneLine /></InDialog>,
          },
          {
            id: 'gutter',
            label: 'Gutter + pencil',
            note: 'Glyphs in a fixed left column so chips and note text share one left edge. Edit becomes a pencil in the corner — the whole card is already the target.',
            render: () => <InDialog><CardGutter /></InDialog>,
          },
          {
            id: 'quote',
            label: 'Note as quotation',
            note: 'The note gets a left rule and the muted colour, so "labels I applied" and "a sentence I wrote" separate at a glance. Tallest of the three.',
            render: () => <InDialog><CardQuote /></InDialog>,
          },
        ],
      },
    ],
  },
];
