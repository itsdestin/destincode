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
import {
  Button,
  Radio,
  RadioGroup,
  SegmentedTabs,
  SettingRow,
  Toggle,
  fieldClasses,
} from '../../../components/ui';
import { TagChip } from '../../../components/tags/TagChip';
import { TagPicker } from '../../../components/tags/TagPicker';
import { NoteEditor } from '../../../components/tags/NoteEditor';
import { useTagRegistry } from '../../../hooks/useTagRegistry';
import { PRIORITY_TAG, PRIORITY_HINT } from '../../../components/tags/built-in-tags';
// Shared with the shipping surfaces — a candidate must draw the SAME mark the
// app does, or the comparison is against something that doesn't exist.
import { TagGlyph, NotePageGlyph, PencilGlyph } from '../../../components/tags/glyphs';
import type { TagRecord } from '../../../../shared/tags';
import type { NativePermissionMode } from '../../../../shared/permission-types';
// The mode copy, reproduced verbatim from the shipping screen — the candidate
// these rounds called VariantC, which is now components/PermissionsSection.tsx.
// See permission-modes.ts's header for why it is a copy rather than an import.
import {
  ALWAYS_ASKS,
  MODES,
  MODE_ARIA,
  MODE_IDS,
  MODE_LOCATION_NOTE,
  SECTION_LABEL,
  type PermissionModeDef,
} from './permission-modes';
import type { CompareSurface } from './types';
// The ask card's status glyph — same mark ToolCard's awaiting-approval header draws.
import { QuestionIcon } from '../../../components/Icons';

const WORK_TAG = { label: 'work', color: 'tag-blue' } as const;
const NOTE = 'blocked on the gh dead-end';
// A realistic long note. Short fixture text made every overflow treatment look
// identical, which is exactly the failure mode the workbench's stress scenario
// exists to prevent — see the spec's fidelity contract.
const NOTE_LONG = 'blocked on the gh dead-end — the token refresh works locally but CI '
  + 'still 403s on the first push, so I parked it until we can test against a clean runner';

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

// ── Round 4: the note's glyph and its text treatment ─────────────────────────
// B (gutter + pencil) won round 3, so the layout is settled: glyphs in a fixed
// left column, chips and note sharing one left edge, a pencil in the corner.
//
// TWO CHANGES, ONE COMPARED. The note glyph moves from the notebook-with-a-
// pencil to a lined PAGE (NotePageGlyph below) in all three candidates — that
// was a direct instruction, not a question, and the old glyph read as "edit a
// note" when this row only DISPLAYS one. The pencil in the corner is the edit
// affordance; two pencils in one card was the confusion.
//
// What IS being compared is the note TEXT: box it, quote it, or just let it be
// the biggest thing in the card. The icon stays identical across all three on
// purpose — varying two things at once means the pick can't tell you which one
// you preferred.

/** Boxed. The note sits in its own `bg-well` container, one step deeper than
 *  the card, so it reads as CONTENT held by the card rather than another line
 *  of metadata. Most structure, most pixels. Empty: the box goes with it. */
function CardNoteBoxed() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NotePageGlyph className="w-3 h-3 text-fg-muted self-start mt-1" />
          <span className="rounded-md bg-well px-2 py-1 text-2xs text-fg-2 leading-snug line-clamp-2 min-w-0">
            {NOTE}
          </span>
        </span>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Quoted. Italic, muted, in typographic quotes — no box at all. Says "these
 *  are your words" through typography instead of a container, which keeps the
 *  card as light as round 3's. Empty: nothing left behind. */
function CardNoteQuoted() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NotePageGlyph className="w-3 h-3 text-fg-muted" />
          <span className="text-2xs text-fg-muted italic truncate min-w-0">“{NOTE}”</span>
        </span>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Undecorated, but promoted. No box and no quotes — instead the note is simply
 *  the most prominent thing in the card: full text colour at the chip row's
 *  size, with the page glyph doing all the labelling. Lightest, and it bets
 *  that the glyph is enough context. Empty: the row disappears. */
function CardNotePlain() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NotePageGlyph className="w-3 h-3 text-fg-muted" />
          <span className="text-xs text-fg truncate min-w-0">{NOTE}</span>
        </span>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 5: within the quoted note ──────────────────────────────────────────
// B (italic in quotes) won round 4, so the direction is settled: typography
// rather than a container. What is still open is the one thing a short fixture
// note could never show — what happens when the note is actually long, which is
// most real notes. All three use NOTE_LONG for exactly that reason.
//
// The axis is overflow, and it is a genuine trade: a fixed height keeps the
// dialog's primary button where the user expects it, an unbounded one respects
// what they wrote. Italic is varied alongside it because at text-2xs italic
// costs real legibility, and that only shows up over two full lines.

/** Round 4's winner, unchanged, on a long note. One line, ellipsis. The card
 *  never changes height no matter what was written — and you can read about
 *  four words of it. */
function CardQuoteOneLine() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <NoteGutter>
          <span className="text-2xs text-fg-muted italic truncate min-w-0">“{NOTE_LONG}”</span>
        </NoteGutter>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Two lines, then ellipsis. Roughly a full sentence gets through, and the card
 *  still has a ceiling — it can grow by one line and no further. Italic kept. */
function CardQuoteTwoLines() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <NoteGutter align="start">
          <span className="text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0">“{NOTE_LONG}”</span>
        </NoteGutter>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Unclamped, and NOT italic. The note wraps to whatever it needs, so nothing
 *  the user wrote is hidden — at the cost of an unbounded card that pushes
 *  "Close session" down the dialog. Roman rather than italic because two or
 *  three full lines of italic at this size is where it stops being comfortable;
 *  the quotes carry the signal on their own. */
function CardQuoteFull() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <NoteGutter align="start">
          <span className="text-2xs text-fg-muted leading-snug min-w-0">“{NOTE_LONG}”</span>
        </NoteGutter>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** The settled gutter grid — tag row above, note row below, page glyph in the
 *  fixed column. `align` lifts the glyph to the first text line when the note
 *  wraps, instead of centring it against a two-line block. */
function NoteGutter({ children, align = 'center' }: {
  children: React.ReactNode; align?: 'center' | 'start';
}) {
  return (
    <span className={`grid grid-cols-[16px_1fr] gap-x-1.5 gap-y-1.5 pr-6 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <TagGlyph className={`w-3 h-3 text-fg-muted ${align === 'start' ? 'mt-0.5' : ''}`} />
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        <TagChip tag={PRIORITY_TAG} />
        <TagChip tag={WORK_TAG} />
      </span>
      <NotePageGlyph className={`w-3 h-3 text-fg-muted ${align === 'start' ? 'mt-0.5' : ''}`} />
      {children}
    </span>
  );
}

/** The round-3 winner's shell, shared so round 4 can vary only what is inside
 *  it — card, hover, and the corner pencil are identical across all three. */
function GutterCard({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-1.5 transition-colors hover:border-edge hover:bg-well"
    >
      {children}
      <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
        <PencilGlyph className="w-3.5 h-3.5" />
      </span>
    </button>
  );
}

// ── Round 6: the edit flow ───────────────────────────────────────────────────
// The card is settled through round 5. What is being refined now is what
// happens when you act on it — how you get into editing, whether you can still
// see what is applied while you do, and how you get out.
//
// These candidates run the REAL TagPicker and NoteEditor against the mock
// backend, not stand-ins: an edit flow can only be judged by using it, and a
// fake picker would hide exactly the friction being compared.

/** Shared editing state, so all three candidates start from the same content
 *  and the only difference on screen is the flow. */
function useDraft() {
  const registry = useTagRegistry();
  const [tagIds, setTagIds] = React.useState<Set<string>>(new Set(['tag_work']));
  const [priority, setPriority] = React.useState(true);
  const [note, setNote] = React.useState(NOTE_LONG);
  const toggleTag = (id: string, next: boolean) => setTagIds((prev) => {
    const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s;
  });
  // Typed narrowing rather than `filter(Boolean)` — the latter leaves
  // TagRecord|undefined and every consumer then needs a guard.
  const chips = [...tagIds]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  return { registry, tagIds, toggleTag, priority, setPriority, note, setNote, chips };
}

/** The settled summary body — round 5's B. Shared by the flows that show it. */
function SummaryBody({ chips, priority, note }: {
  chips: TagRecord[]; priority: boolean; note: string;
}) {
  return (
    <span className="grid grid-cols-[16px_1fr] items-start gap-x-1.5 gap-y-1.5 pr-6">
      <TagGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        {priority && <TagChip tag={PRIORITY_TAG} />}
        {chips.map((t) => <TagChip key={t.id} tag={t} />)}
        {!priority && chips.length === 0 && <span className="text-2xs text-fg-muted">No tags</span>}
      </span>
      <NotePageGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
      {note.trim()
        ? <span className="text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0">“{note.trim()}”</span>
        : <span className="text-2xs text-fg-muted min-w-0">No note</span>}
    </span>
  );
}

/** The editor body, identical in every flow that has one. */
function EditorBody({ d }: { d: ReturnType<typeof useDraft> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <TagPicker
        appliedIds={d.tagIds}
        onToggle={d.toggleTag}
        registry={d.registry}
        onManageTags={() => {}}
        builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
      />
      <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mt-1">Note</label>
      <NoteEditor value={d.note} onSave={d.setNote} />
    </div>
  );
}

/** REPLACE — what ships today. The card swaps to the editor; a "Done" text link
 *  swaps it back. Least chrome, but while editing you cannot see the summary
 *  you were changing, and "Done" is a small target for the only way out. */
function FlowReplace() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
            <button type="button" onClick={() => setEditing(false)}
              className="text-3xs text-fg-muted hover:text-fg transition-colors">Done</button>
          </div>
          <EditorBody d={d} />
        </div>
      ) : (
        <GutterCard onClick={() => setEditing(true)}>
          <SummaryBody chips={d.chips} priority={d.priority} note={d.note} />
        </GutterCard>
      )}
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** EXPAND — the summary stays put as a header and the editor opens beneath it
 *  inside the same card, so you can see what you are changing while you change
 *  it. The pencil becomes a chevron. Costs height: summary and editor are on
 *  screen together. */
function FlowExpand() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge-dim bg-inset overflow-hidden">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
          className="group relative w-full text-left px-3 py-2.5 transition-colors hover:bg-well"
        >
          <SummaryBody chips={d.chips} priority={d.priority} note={d.note} />
          <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
            <ChevronGlyph className={`w-3.5 h-3.5 transition-transform ${editing ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {editing && (
          <div className="border-t border-edge-dim px-3 py-2.5">
            <EditorBody d={d} />
          </div>
        )}
      </div>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** NO MODE — nothing to enter or leave. Applied chips carry an × , a dashed
 *  "+ tag" chip drops the picker in below, and the note row becomes a field
 *  when clicked. Fewest clicks to a small change; the card is busier at rest,
 *  and there is no single "I'm done" moment. */
function FlowInline() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [notingNote, setNotingNote] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-2">
        <div className="grid grid-cols-[16px_1fr] items-start gap-x-1.5 gap-y-2">
          <TagGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
          <div className="flex flex-wrap items-center gap-1 min-w-0">
            {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
            {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
            <button type="button" onClick={() => setPicking((v) => !v)}
              className="px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
              + tag
            </button>
          </div>
          <NotePageGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
          {notingNote ? (
            <NoteEditor value={d.note} onSave={(t) => { d.setNote(t); setNotingNote(false); }} />
          ) : (
            <button type="button" onClick={() => setNotingNote(true)}
              className="text-left text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0 hover:text-fg-2 transition-colors">
              {d.note.trim() ? `“${d.note.trim()}”` : 'Add a note…'}
            </button>
          )}
        </div>
        {picking && (
          <div className="border-t border-edge-dim pt-2">
            <TagPicker
              appliedIds={d.tagIds}
              onToggle={d.toggleTag}
              registry={d.registry}
              onManageTags={() => {}}
              builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
            />
          </div>
        )}
      </div>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 7: keeping the card while editing ──────────────────────────────────
// A (replace in place) won round 6, but it dropped the card on the way in — the
// editor became a bare labelled section on the dialog, so the body visibly
// changed shape when you clicked. All three candidates here fix that: the
// bordered container stays put and only its CONTENTS swap, which is B's
// containment with A's one-thing-at-a-time.
//
// That leaves one real question. With the editor open the pencil is gone (you
// are already editing), so the way OUT needs its own affordance, and it is the
// only control in the card that is not part of the editor.

/** The card that holds either state, so the border, fill and padding are
 *  literally the same element before and after the swap — nothing shifts. */
function EditCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5">{children}</div>
  );
}

/** Summary content, as a click target filling the card. */
function EditCardSummary({ d, onEdit }: { d: ReturnType<typeof useDraft>; onEdit: () => void }) {
  return (
    <button type="button" onClick={onEdit} className="group relative w-full text-left">
      <SummaryBody chips={d.chips} priority={d.priority} note={d.note} />
      <span className="absolute top-0 right-0 text-fg-faint group-hover:text-fg transition-colors">
        <PencilGlyph className="w-3.5 h-3.5" />
      </span>
    </button>
  );
}

/** Done as a text link where the pencil was — the exit sits exactly where the
 *  way in was, so the corner is consistently "the control for this card".
 *  Quietest, and the smallest target. */
function FlowCardLink() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
              <button type="button" onClick={() => setEditing(false)}
                className="text-3xs text-fg-muted hover:text-fg transition-colors">Done</button>
            </div>
            <EditorBody d={d} />
          </div>
        ) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** A checkmark in the corner, replacing the pencil in place. The card's corner
 *  always holds its one control and the glyph says which mode you are in —
 *  pencil to edit, check to finish. No words, same target size as the pencil. */
function FlowCardCheck() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? (
          <div className="relative flex flex-col gap-1.5">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase pr-6">Tags</label>
            <button type="button" onClick={() => setEditing(false)} aria-label="Done editing"
              className="absolute top-0 right-0 text-fg-muted hover:text-fg transition-colors">
              <CheckGlyph className="w-3.5 h-3.5" />
            </button>
            <EditorBody d={d} />
          </div>
        ) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** A full-width Done button closing the card. Unmissable and impossible to
 *  fumble, and it reads as "commit this section" — which is a small lie, since
 *  nothing is committed until the dialog's own button. Tallest by a row. */
function FlowCardButton() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? (
          <div className="flex flex-col gap-2">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
            <EditorBody d={d} />
            <Button variant="secondary" size="sm" className="w-full" onClick={() => setEditing(false)}>Done</Button>
          </div>
        ) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 8: tightening the editor ───────────────────────────────────────────
// C (full-width button) won round 7, with the label changed from "Done" to
// "Save" on a darker pill. All three candidates below carry that same button,
// so it is settled, not compared:
//
//   `secondary` is the outline — too quiet for the one action closing a
//   section. `primary` is the accent, which would compete with the dialog's own
//   "Close session". So SaveButton is a filled NEUTRAL pill: bg-well with a
//   border, rounded-full. Darker than the card it sits in, quieter than accent.
//
// What is compared is the editor above it, which measured 9 stacked bands in
// round 7: label, search, four tag rows, a manage link, a second label, and a
// three-row textarea. Each candidate cuts that a different way.

/** The settled Save control. Pill, filled, neutral — deliberately not accent,
 *  which belongs to the dialog's own confirm. */
function SaveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-full bg-well border border-edge-dim px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-edge hover:border-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      Save
    </button>
  );
}

/** MERGED HEADERS. The two section labels stop owning their own lines: "Tags"
 *  shares its row with "Manage tags…", and the note loses its label entirely —
 *  its placeholder already says what it is. Rows tighten and the note drops to
 *  two lines. Same structure, three bands less. */
function EditTightHeaders({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
        <button type="button" className="text-3xs text-fg-muted hover:text-fg transition-colors">Manage tags…</button>
      </div>
      <TagPicker
        appliedIds={d.tagIds}
        onToggle={d.toggleTag}
        registry={d.registry}
        builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
      />
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** APPLIED FIRST. What is already on the conversation sits as removable chips
 *  directly under the search, and the list beneath offers only what is NOT
 *  applied. With three tags on, the list you scan is three rows shorter — and
 *  "what does this have" stops being a hunt through checkboxes. */
function EditAppliedFirst({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-edge-dim pt-2">
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)}
            className="opacity-60 hover:opacity-100 transition-opacity">
            <TagChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)}
            className="opacity-60 hover:opacity-100 transition-opacity">
            <TagChip tag={t} />
          </button>
        ))}
        <button type="button" className="px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
          + new
        </button>
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** ONE WELL. Tags and note share a single inset container split by a divider,
 *  so the editor reads as one object rather than two stacked sections. No
 *  labels at all — a tag row and a text field do not need naming. The most
 *  compact, and the furthest from the app's existing form language. */
function EditOneWell({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md bg-well border border-edge-dim divide-y divide-edge-dim">
        <div className="p-2">
          <TagPicker
            appliedIds={d.tagIds}
            onToggle={d.toggleTag}
            registry={d.registry}
            builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
          />
        </div>
        <div className="p-2">
          <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
        </div>
      </div>
      <SaveButton onClick={onSave} />
    </div>
  );
}

// ── Round 9: mechanics of the applied/available split ────────────────────────
// B (applied first, rest as chips) won round 8 on concept: what is ON sits
// apart from what is available, and both are chips rather than checkbox rows.
// Round 9 keeps that and varies the MECHANIC — how a tag gets added, removed,
// and where the available set lives when you are not using it.
//
// The note field and the Save pill are identical in all three.

/** TOKEN FIELD. Applied tags live INSIDE the search input, the way an email
 *  To: field works: type to filter, Enter adds the top match or creates,
 *  Backspace on an empty field removes the last chip, × removes any. One
 *  control instead of two rows — and the search that round 8's B gave up comes
 *  back for free, because it is the same box. */
function EditTokenField({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const [q, setQ] = React.useState('');
  const matches = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id)
    && (!q || t.label.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="flex flex-col gap-2">
      <div className={fieldClasses('sm', 'flex flex-wrap items-center gap-1 min-h-[34px] cursor-text')}>
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) { e.preventDefault(); d.toggleTag(matches[0].id, true); setQ(''); }
            // Backspace on an empty field peels the last chip — the behaviour
            // that makes a token field feel like a field rather than a list.
            if (e.key === 'Backspace' && !q && d.chips.length) d.toggleTag(d.chips[d.chips.length - 1].id, false);
          }}
          placeholder={d.priority || d.chips.length ? '' : 'Add tags…'}
          aria-label="Add tags"
          className="flex-1 min-w-[80px] bg-transparent text-2xs text-fg placeholder:text-fg-muted outline-none"
        />
      </div>
      {q && (
        <div className="flex flex-wrap items-center gap-1">
          {matches.map((t) => (
            <button key={t.id} type="button" onClick={() => { d.toggleTag(t.id, true); setQ(''); }}
              className="opacity-70 hover:opacity-100 transition-opacity"><TagChip tag={t} /></button>
          ))}
          {matches.length === 0 && (
            <span className="text-3xs text-fg-muted">Enter to create “{q}”</span>
          )}
        </div>
      )}
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** CHIPS + "+" DISCLOSURE. At rest the editor shows ONLY what is applied, plus
 *  a "+". The available set costs nothing until you ask for it, which is the
 *  tightest resting state of the three — at the price of one extra click for
 *  every add, and a list that appears and disappears under your cursor. */
function EditPlusDisclosure({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const [open, setOpen] = React.useState(false);
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="w-5 h-5 rounded-full border border-dashed border-edge text-fg-muted hover:text-fg hover:border-edge transition-colors flex items-center justify-center text-3xs leading-none">
          +
        </button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-1 rounded-md bg-well border border-edge-dim p-2">
          {!d.priority && (
            <button type="button" onClick={() => d.setPriority(true)}
              className="opacity-70 hover:opacity-100 transition-opacity"><TagChip tag={PRIORITY_TAG} /></button>
          )}
          {unapplied.map((t) => (
            <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)}
              className="opacity-70 hover:opacity-100 transition-opacity"><TagChip tag={t} /></button>
          ))}
          <button type="button" className="px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
            + new
          </button>
        </div>
      )}
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** TWO COLUMNS. Applied on the left, available on the right, both always
 *  visible; clicking a chip moves it across. Nothing is hidden and nothing
 *  toggles, so the state is never in doubt — but it spends horizontal space the
 *  380px dialog does not really have, and each column wraps sooner. */
function EditTwoColumns({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-4xs font-medium text-fg-muted tracking-wider uppercase">On</span>
          <div className="flex flex-wrap items-start gap-1 content-start min-h-[48px] rounded-md bg-well border border-edge-dim p-1.5">
            {d.priority && (
              <button type="button" onClick={() => d.setPriority(false)}><TagChip tag={PRIORITY_TAG} /></button>
            )}
            {d.chips.map((t) => (
              <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, false)}><TagChip tag={t} /></button>
            ))}
            {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted px-0.5">None</span>}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-4xs font-medium text-fg-muted tracking-wider uppercase">Available</span>
          <div className="flex flex-wrap items-start gap-1 content-start min-h-[48px] rounded-md bg-well border border-edge-dim p-1.5">
            {!d.priority && (
              <button type="button" onClick={() => d.setPriority(true)} className="opacity-70 hover:opacity-100 transition-opacity">
                <TagChip tag={PRIORITY_TAG} />
              </button>
            )}
            {unapplied.map((t) => (
              <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="opacity-70 hover:opacity-100 transition-opacity">
                <TagChip tag={t} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

// ── Round 10: organising the tag chips ───────────────────────────────────────
// Round 9 was the wrong axis. R8·B was liked for its LAYOUT — applied above,
// available below, plain chips, plain click — and round 9 answered "tighten it"
// by making the interaction cleverer, which is the opposite. These three keep
// R8·B's mechanic exactly (click a chip, that is all) and vary only how the
// chips are ORGANISED on the page.

/** An available chip drawn as an outline rather than a dimmed fill. TagChip
 *  sets its background with an inline style, which no className can override,
 *  so this is a local variant — if it wins, TagChip gains an `outline` prop and
 *  this goes away. */
function OutlineChip({ tag }: { tag: { label: string; color: string } }) {
  const c = `var(--${tag.color})`;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed"
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)` }}
    >
      {tag.label}
    </span>
  );
}

/** ONE FLOW. No two blocks and no rule — applied chips first, a single dot
 *  separator, then the available ones dimmed, all in one wrapped run. You read
 *  it left to right as "these are on … these are not". Fewest bands of the
 *  three; the boundary is a single character, which is either elegant or
 *  invisible depending on how many tags are applied. */
function EditFlowOne({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        <span className="text-fg-faint text-3xs px-1">·</span>
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)} className="opacity-50 hover:opacity-100 transition-opacity">
            <TagChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="opacity-50 hover:opacity-100 transition-opacity">
            <TagChip tag={t} />
          </button>
        ))}
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** OUTLINE VS FILLED. Still two groups, but the difference is drawn rather than
 *  faded: applied chips keep their fill, available ones are dashed outlines. No
 *  divider rule is needed because the styling already separates them, and a
 *  dashed outline reads as "not yet" the way opacity never quite does. */
function EditOutline({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)} className="hover:opacity-70 transition-opacity">
            <OutlineChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="hover:opacity-70 transition-opacity">
            <OutlineChip tag={t} />
          </button>
        ))}
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** FIXED STRIP. Applied chips wrap freely; the available set is ONE row that
 *  scrolls sideways. The editor's height then never changes as the registry
 *  grows — the thing that makes every wrapped-cloud design worse the longer you
 *  use the app. Costs discoverability: tags past the right edge are only found
 *  by scrolling. */
function EditFixedStrip({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto rounded-md bg-well border border-edge-dim px-1.5 py-1">
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)} className="shrink-0 opacity-70 hover:opacity-100 transition-opacity">
            <TagChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="shrink-0 opacity-70 hover:opacity-100 transition-opacity">
            <TagChip tag={t} />
          </button>
        ))}
        <button type="button" className="shrink-0 px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
          + new
        </button>
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** Round 7's winning shell, with the editor body swapped per candidate. */
function EditFlowCard({ render }: {
  render: (d: ReturnType<typeof useDraft>, onSave: () => void) => React.ReactNode;
}) {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(true);   // open, since it is what is being judged
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? render(d, () => setEditing(false)) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

function CheckGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ChevronGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 9l-7 7-7-7" />
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

// ═════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — Settings → Permissions, the mode control
// ═════════════════════════════════════════════════════════════════════════════
//
// WHAT IS ACTUALLY BEING DECIDED. The Permissions screen opens with a control
// for how much the assistant checks with you: three modes, one obviously-safe
// default (Ask first) and two progressively riskier ones. A first round of
// design was rejected by the owner in these words:
//
//   "all three offered UIs make it look like i'm selecting a permissions mode,
//    when that selection actually does fucking nothing."
//
// TWO SEPARATE PROBLEMS live in that sentence, and only one of them is a design
// problem. The setting being inert is being fixed in the main process — a
// persisted default mode that new conversations start in. So every candidate
// here is authored as a control that GENUINELY OWNS A VALUE: it takes `value`
// and `onChange`, and the pane drives them from its own state. Nothing here
// carries copy or an affordance implying a setting that does not exist.
//
// What is left for this surface is the design half: the three forms that exist
// today all present the modes as three interchangeable options, and they are
// not interchangeable — they are a default and two escalations away from it.
//
// FRAME. `panel` at 420px, which is the real thing: the Permissions dialog is
// size="panel" (DIALOG_WIDTHS.panel = min(420px, 88vw)) and never gets wider.
// These definitions wrap at that width, which is most of what there is to judge.
// The real <Dialog> is NOT rendered — it is fixed-position and would stack every
// pane in the middle of the screen (see types.ts).

type ModeControlProps = {
  value: NativePermissionMode;
  onChange: (next: NativePermissionMode) => void;
};

/** One mode as a radio-list row: the <Radio> lives in SettingRow's icon slot and
 *  the whole tile is the hit target, so you never have to aim at the 14px
 *  circle. Shared by the candidates that use this row shape, so the only thing
 *  differing between them is the arrangement AROUND the rows. */
function ModeRow({ m, value, onChange }: { m: PermissionModeDef } & ModeControlProps) {
  return (
    <SettingRow
      variant="item"
      title={m.label}
      description={m.line}
      selected={value === m.id}
      onSelect={() => onChange(m.id)}
      // Roving tabindex: only the chosen option is tabbable, so Tab enters and
      // leaves the group in one stop (what native radios give free).
      radioTabIndex={value === m.id ? 0 : -1}
    />
  );
}

// ── Round 1: the three controls that already exist ───────────────────────────
// Verbatim in behaviour and copy from VariantC.tsx's `?mc=1|2|3` scaffold, so
// the lineage starts from something real rather than from a blank page. The one
// change is the prop names — `value`/`onChange` instead of `mode`/`onChange` —
// because a control that owns a value is what the next round is arguing about.

/** 1 — RADIO LIST (VariantC's recommendation, and its default with no `?mc`).
 *
 *  K3's "any option needs a description" form: a <RadioGroup> (one tab stop,
 *  arrow keys walk it) around three <SettingRow variant="item">s. */
function ModeRadioList({ value, onChange }: ModeControlProps) {
  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => onChange(id as NativePermissionMode)}
      className="space-y-1"
    >
      {MODES.map((m) => (
        <ModeRow key={m.id} m={m} value={value} onChange={onChange} />
      ))}
    </RadioGroup>
  );
}

/** 2 — SEGMENTED, WITH THE WHOLE KEY SHOWN.
 *
 *  The picker stays a single row (the most compact of the three) and all three
 *  definitions print beneath it as a fixed key. The key is deliberately
 *  UNEMPHASISED — the segmented control already draws the selection in
 *  bg-accent, and a second selected/unselected treatment down here would be a
 *  hand-rolled active/inactive pair in everything but name. */
function ModeSegmentedWithKey({ value, onChange }: ModeControlProps) {
  return (
    <>
      <SegmentedTabs
        variant="contained"
        aria-label={MODE_ARIA}
        tabs={MODES.map((m) => ({ id: m.id, label: m.label }))}
        value={value}
        onChange={(id) => onChange(id as NativePermissionMode)}
      />
      <ul className="mt-2 space-y-1.5">
        {MODES.map((m) => (
          <li key={m.id} className="text-2xs text-fg-muted leading-relaxed">
            <span className="text-fg-2 font-medium">{m.label}</span> — {m.line}
          </li>
        ))}
      </ul>
    </>
  );
}

/** 3 — ROWS WITH THE RADIO ON THE RIGHT.
 *
 *  Same rows, opposite geometry: the <Radio> sits in SettingRow's `control`
 *  slot, so the title and its definition get the row's full left edge — the
 *  thing worth comparing at 420px, where these definitions wrap. The whole row
 *  still selects, and SettingRow stops the Radio's own click from bubbling back
 *  into it, so one tap is one change. */
function ModeTrailingRadios({ value, onChange }: ModeControlProps) {
  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => onChange(id as NativePermissionMode)}
      className="space-y-1"
    >
      {MODES.map((m) => (
        <SettingRow
          key={m.id}
          variant="item"
          title={m.label}
          description={m.line}
          onClick={() => onChange(m.id)}
          control={
            <Radio
              checked={value === m.id}
              onChange={() => onChange(m.id)}
              tabIndex={value === m.id ? 0 : -1}
              aria-label={m.label}
            />
          }
        />
      ))}
    </RadioGroup>
  );
}

// ── Round 2: forms that are not a picker of three equals ─────────────────────
// The axis is the SHAPE of the choice, not its copy — every mode definition is
// still the verbatim string from permission-modes.ts in all three, so a pick
// tells you which presentation you preferred rather than which sentence.

/** A — STATE FIRST. At rest this is not a picker at all: one row states how the
 *  assistant behaves today, with a quiet "Change" beside it. Clicking it opens
 *  the full three-option list, and choosing closes it again, so picking a mode
 *  is a deliberate second step rather than the screen's opening question.
 *
 *  The trade, stated plainly: at rest you can no longer compare the three
 *  definitions, which is precisely what VariantC's second owner review bought by
 *  printing all three at once. This candidate bets that a SETTING should read as
 *  its current value, and that the comparison is one click away when you
 *  actually want it. */
function ModeStateFirst({ value, onChange }: ModeControlProps) {
  const [changing, setChanging] = React.useState(false);
  // MODE_IDS covers every NativePermissionMode, so this cannot miss — but fall
  // back rather than assert, since a bad `!` here would blank the whole pane.
  const current = MODES.find((m) => m.id === value) ?? MODES[0];

  if (!changing) {
    return (
      <SettingRow
        variant="item"
        title={current.label}
        description={current.line}
        // Ghost is the family's lightest button: the row is a statement of
        // state, and the way to change it should not out-shout the state.
        control={
          <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
            Change
          </Button>
        }
      />
    );
  }

  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => {
        onChange(id as NativePermissionMode);
        setChanging(false);
      }}
      className="space-y-1"
    >
      {MODES.map((m) => (
        <ModeRow
          key={m.id}
          m={m}
          value={value}
          onChange={(next) => {
            onChange(next);
            setChanging(false);
          }}
        />
      ))}
    </RadioGroup>
  );
}

/** B — DEFAULT, THEN THE STEP-UPS. All three rows stay visible and all three
 *  definitions stay readable, but they stop being a flat stack: Ask first sits
 *  alone as the plain choice, and the two that trade oversight for fewer
 *  interruptions are held in ONE bordered card under a label saying what they
 *  have in common.
 *
 *  Containment rather than indent, deliberately — the rejected Permissions
 *  design expressed "these belong to that" with 8px of padding and nothing else,
 *  and the fix that stuck (VariantC's FolderCard) was a border on all four
 *  sides. Same class recipe here: rounded-lg border border-edge bg-well. */
function ModeStepUps({ value, onChange }: ModeControlProps) {
  const [base, ...stepUps] = MODES;
  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => onChange(id as NativePermissionMode)}
      className="space-y-2"
    >
      <ModeRow m={base} value={value} onChange={onChange} />
      <div className="rounded-lg border border-edge bg-well overflow-hidden pt-2.5 px-1 pb-1">
        {/* Authored copy classifying the rows under it — a section label, and it
            takes the canonical spelling. px-2 lands it on the same left edge as
            the row titles beneath (the rows carry their own px-3 inside the
            card's px-1). */}
        <h3 className={`${SECTION_LABEL} px-2`}>Fewer interruptions</h3>
        <div className="space-y-1">
          {stepUps.map((m) => (
            <ModeRow key={m.id} m={m} value={value} onChange={onChange} />
          ))}
        </div>
      </div>
    </RadioGroup>
  );
}

/** Indent per step. A key whose lines hang progressively further right reads as
 *  a staircase, which is the whole point of this candidate — so the values are
 *  named here rather than computed, and there are exactly as many as MODES. */
const STEP_INDENT = ['', 'pl-3', 'pl-6'];

/** C — A SCALE, NOT A ROW OF TABS. The compact segmented picker survives — it is
 *  by far the smallest of the forms — but it is reframed as an axis: the ends
 *  are named underneath it, and the key below steps one indent further right per
 *  mode, so left-to-right and top-to-bottom both mean the same thing.
 *
 *  Nothing in the key is emphasised by selection, for R1·B's reason: the
 *  segmented control already draws the selection, and a second active/inactive
 *  treatment down here would be a hand-rolled choice group in all but name. */
function ModeScale({ value, onChange }: ModeControlProps) {
  return (
    <>
      <SegmentedTabs
        variant="contained"
        aria-label={MODE_ARIA}
        tabs={MODES.map((m) => ({ id: m.id, label: m.label }))}
        value={value}
        onChange={(id) => onChange(id as NativePermissionMode)}
      />
      {/* The axis. Not a section label — no uppercase, no tracking — because
          these are the ends of a scale, not a heading over a group. */}
      <div className="mt-1.5 flex items-center justify-between text-3xs text-fg-muted">
        <span>Checks with you most</span>
        <span>Checks with you least</span>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {MODES.map((m, i) => (
          <li key={m.id} className={`text-2xs text-fg-muted leading-relaxed ${STEP_INDENT[i]}`}>
            <span className="text-fg-2 font-medium">{m.label}</span> — {m.line}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The always-ask list, identical in every candidate. It is here rather than
 *  cropped out because Full auto's definition ends "The list below is the
 *  exception" — judged without a list below it, that sentence points at nothing.
 *  Copied from VariantC's section 2, including the reason it is a quiet card and
 *  not a stack of rows: there is nothing here to toggle, and <SettingRow>s would
 *  promise a control that does not exist. */
function AlwaysAsksSection() {
  return (
    <div>
      <h3 className={SECTION_LABEL}>Things it always asks about</h3>
      <div className="rounded-lg bg-inset/50 px-3 py-2.5 space-y-1.5">
        <p className="text-3xs text-fg-muted">Even on Full auto:</p>
        <ul className="text-2xs text-fg-2 leading-relaxed list-disc pl-4 space-y-1">
          {ALWAYS_ASKS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Mounts one mode control in the dialog it actually lives in: the Permissions
 *  header band above it, the section label it sits under, and the always-asks
 *  section below. The state is HERE — every candidate is a real control over a
 *  real value, so it responds like the setting it is about to become. */
function ModePane({ control: Control }: { control: React.ComponentType<ModeControlProps> }) {
  const [mode, setMode] = React.useState<NativePermissionMode>('ask');
  return (
    <div className="flex flex-col">
      {/* Dialog.tsx's own header geometry, not the real <Dialog> — see the
          surface comment above for why the component itself cannot be used. */}
      <div className="px-4 py-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Permissions</h2>
      </div>
      {/* px-4 py-4 space-y-5 is Dialog's scroll-body track, so the control is
          judged with the padding it will really have. */}
      <div className="px-4 py-4 space-y-5">
        <div>
          {/* Matches the explainer's own "How much it asks" section, so the (i)
              reads as the long version of what is on screen. */}
          <h3 className={SECTION_LABEL}>How much it asks</h3>
          <Control value={mode} onChange={setMode} />
        </div>
        <AlwaysAsksSection />
      </div>
    </div>
  );
}

// ── Round 3: not a control at all ────────────────────────────────────────────
// R1 and R2 were discarded TOGETHER, and the fault was not styling. All six
// candidates were CONTROLS — radio lists, segmented tabs, a row with a Change
// button — and every one of them read as a live selector for a setting this
// screen does not own:
//
//   "this IS NOT AND SHOULD NOT BE A REAL PERMISSIONS SELECTOR. it still looks
//    like a live selector that changes a setting"
//
// The reason it can never be one: permission mode is per-CONVERSATION state,
// owned by NativeSessionHost and set from the status-bar chip at the bottom of
// the chat. There is no app-wide default for this screen to write to, so a
// control here would either do nothing (a lie in the shape of a control) or
// force the invention of a setting that does not exist. The R2 header above
// bet that the inertness would be fixed in the main process and the design
// question was the shape of the picker; that bet was wrong, and this round is
// where it is paid off.
//
// So every candidate below is a PRESENTATION OF REFERENCE CONTENT: three terms
// and their definitions, printed as facts, exactly the way ALWAYS_ASKS is. No
// selected state, no radios, no tabs, nothing focusable, no hover affordance —
// and each one prints MODE_LOCATION_NOTE, so the reader is told where the mode
// really is changed rather than left hunting this screen for it.
//
// THE AXIS IS CONTAINMENT: a card of its own (A), no container at all (B), or
// one container shared with the always-asks list below (C). Copy is identical
// in all three, MODES verbatim, so a pick names the presentation.
//
// Most of this is text, so most of it is plain tokens rather than primitives —
// which is the honest answer here, not a shortcut. There is no primitive for
// "three definitions", and reaching for <SettingRow> to get one would put row
// geometry (and its click affordance) around content that is not a row.

/** The run-in definitions A and C share: the term in full text colour, its
 *  sentence continuing on the same line. Identical in both on purpose, so what
 *  separates those two candidates is the container and nothing else. */
function RunInDefinitions() {
  return (
    <div className="space-y-2">
      {MODES.map((m) => (
        <p key={m.id} className="text-2xs text-fg-2 leading-relaxed">
          <span className="font-medium text-fg">{m.label}</span>
          {' — '}
          {m.line}
        </p>
      ))}
    </div>
  );
}

/** A — THE QUIET CARD. The same `bg-inset/50` informational surface the
 *  always-asks list uses, which is already this screen's established way of
 *  saying "this is a fact about the app, there is nothing to operate here". The
 *  card does the grouping, so the three terms only need weight rather than
 *  lines of their own. This is what the component does today. */
function ModeRefCard() {
  return (
    <div className="rounded-lg bg-inset/50 px-3 py-2.5 space-y-2">
      <RunInDefinitions />
      <p className="text-3xs text-fg-muted">{MODE_LOCATION_NOTE}</p>
    </div>
  );
}

/** B — NO CARD, A REAL DEFINITION LIST. <dl>/<dt>/<dd> is the markup for terms
 *  and their definitions, which is literally what this content is; a screen
 *  reader then announces it as a definition list rather than as three
 *  paragraphs. Nothing is drawn at all — no fill, no border — so there is no
 *  box a reader could mistake for a group of options.
 *
 *  Dropping the card costs the grouping, so the terms take that job back by
 *  standing on their own line at text-xs. That is the same move, not a second
 *  one: without a container the labels have to be the structure. It also puts
 *  the three names in a column you can scan without reading the sentences. */
function ModeRefDefinitions() {
  return (
    <>
      <dl className="space-y-2.5">
        {MODES.map((m) => (
          <div key={m.id}>
            <dt className="text-xs font-medium text-fg">{m.label}</dt>
            <dd className="text-2xs text-fg-2 leading-relaxed">{m.line}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-3xs text-fg-muted">{MODE_LOCATION_NOTE}</p>
    </>
  );
}

/** C — ONE EXPLANATION. The modes and the always-asks list share a SINGLE
 *  bg-inset/50 card, divided into bands. Full auto's own definition ends "The
 *  list below is the exception" — here that list is inside the same box instead
 *  of in a separate section under its own heading, so the sentence points at
 *  something the eye already reads as part of the same statement.
 *
 *  Both headings survive: the always-asks label becomes the second band's
 *  header, the way VariantC's folder cards carry band headers inside a card.
 *  MODE_LOCATION_NOTE closes the whole card rather than just the modes, because
 *  by then it is the one thing left to say. Costs the one-section-per-idea
 *  rhythm the rest of the screen keeps, and it is the tallest single object on
 *  the page. */
function ModeRefCoupled() {
  return (
    <div>
      <h3 className={SECTION_LABEL}>How much it asks</h3>
      <div className="rounded-lg bg-inset/50">
        <div className="px-3 py-2.5">
          <RunInDefinitions />
        </div>
        <div className="border-t border-edge-dim px-3 py-2.5">
          <h3 className={SECTION_LABEL}>Things it always asks about</h3>
          <p className="text-3xs text-fg-muted">Even on Full auto:</p>
          <ul className="mt-1.5 text-2xs text-fg-2 leading-relaxed list-disc pl-4 space-y-1">
            {ALWAYS_ASKS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="border-t border-edge-dim px-3 py-2">
          <p className="text-3xs text-fg-muted">{MODE_LOCATION_NOTE}</p>
        </div>
      </div>
    </div>
  );
}

/** Round 3's pane. Same dialog chrome as ModePane and NO STATE — there is
 *  nothing on this screen that owns a value any more, and a useState here would
 *  be scaffolding for a control that is not being built.
 *
 *  The body is authored by the candidate instead of being pre-drawn, because C
 *  deliberately merges the modes with the always-asks section and so cannot be
 *  handed a fixed "h3 + control + AlwaysAsksSection" sandwich. */
function ReferencePane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 py-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Permissions</h2>
      </div>
      <div className="px-4 py-4 space-y-5">{children}</div>
    </div>
  );
}

/** The two-section body A and B share: the canonical section label, the
 *  candidate's presentation under it, then the always-asks section exactly as
 *  the other rounds render it. */
function ModeRefSections({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div>
        <h3 className={SECTION_LABEL}>How much it asks</h3>
        {children}
      </div>
      <AlwaysAsksSection />
    </>
  );
}

// ── Full-auto ask (M5 2b) ────────────────────────────────────────────────────
// The only rule-based prompt full-auto still shows is a destructive-command
// stop (rulesForMode('full-auto') is `*→allow`; only the deny-list outranks
// it), yet PermissionButtons renders the same generic row as Ask mode —
// nothing says WHY the mode that "works without checking with you" stopped.
// Candidates vary two axes: how much the card explains the stop, and which
// actions it offers. Hard constraint from the shipped Permissions screen: the
// four families (deleting, git push/reset, sudo, format) must KEEP asking.

// StatusBar's full-auto chip colors (PERMISSION_DISPLAY['full-auto']) —
// duplicated because that record is a private const of StatusBar.tsx; if a
// candidate wins, export it and delete this.
const FULL_AUTO_CHIP = {
  color: '#F2B33D',
  bg: 'rgba(242,179,61,0.15)',
  border: 'rgba(242,179,61,0.25)',
};

// The button marks, verbatim from PermissionButtons (ToolCard.tsx) — these are
// the app's hardcoded STATUS colors, deliberately outside ui/Button (spec §11
// change 61), so the candidates must draw exactly these.
const ASK_BTN = 'px-3 py-1 text-xs font-medium rounded-lg transition-colors';
const ASK_GREEN = `${ASK_BTN} bg-green-600/60 hover:bg-green-600/80 text-green-100`;
const ASK_BLUE = `${ASK_BTN} bg-blue-600/60 hover:bg-blue-600/80 text-blue-100`;
const ASK_RED = `${ASK_BTN} bg-red-600/60 hover:bg-red-600/80 text-red-100`;

/** The awaiting-approval ToolCard shell, fixture: a deny-listed `git push` in a
 *  full-auto session. Same classes as ToolCard's header row — the candidates
 *  only vary the footer, so the shell must be the production card or the
 *  comparison is against something that doesn't exist. */
function FullAutoAskShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <div className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left">
        <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs font-medium text-fg-2">Push local commits</span>
        <span className="text-xs text-fg-muted truncate flex-1 min-w-0">↳ git push origin master</span>
      </div>
      {children}
    </div>
  );
}

/** A — today's three buttons, plus one amber line naming why the mode stopped. */
function FullAutoExplainedRow() {
  return (
    <FullAutoAskShell>
      <div className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30">
        <p className="text-2xs leading-relaxed" style={{ color: FULL_AUTO_CHIP.color }}>
          Full auto paused — pushing code is one of the four things it always checks first.
        </p>
        <div className="flex items-center gap-2">
          <button className={ASK_GREEN}>Yes</button>
          <button className={ASK_BLUE}>Always Allow</button>
          <button className={ASK_RED}>No</button>
        </div>
      </div>
    </FullAutoAskShell>
  );
}

/** B — a safety stop: two verbs, and the rule-making action demoted to a quiet
 *  line that opens the existing are-you-sure step. */
function FullAutoSafetyStop() {
  // The link swaps in the existing consequence confirm so the flow is judgeable,
  // not just describable — same copy PermissionButtons ships today.
  const [confirming, setConfirming] = React.useState(false);
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        {confirming ? (
          <>
            <p className="text-xs font-medium text-fg-2">Always allow this exact command in youcoded?</p>
            <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
              git push origin master
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              It can delete files or change published code, and you won't be asked again.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
              <button className={ASK_RED}>Always allow</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>
              Stopped before pushing code
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              Full auto always checks this first — it changes your published code.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN}>Run it</button>
              <button className={ASK_RED}>Skip it</button>
            </div>
            <button
              className="text-3xs text-fg-muted hover:text-fg underline underline-offset-2 transition-colors"
              onClick={() => setConfirming(true)}
            >
              Stop checking this exact command in youcoded
            </button>
          </>
        )}
      </div>
    </FullAutoAskShell>
  );
}

/** C — a mode-branded checkpoint: the chip carries the why, one primary verb,
 *  and no rule-making from the card at all. */
function FullAutoCheckpoint() {
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-3xs font-semibold tracking-wider px-1.5 py-0.5 rounded border"
            style={{
              color: FULL_AUTO_CHIP.color,
              backgroundColor: FULL_AUTO_CHIP.bg,
              borderColor: FULL_AUTO_CHIP.border,
            }}
          >
            FULL AUTO
          </span>
          <span className="text-2xs text-fg-2">checkpoint — pushing code</span>
        </div>
        <p className="text-2xs text-fg-dim leading-relaxed">
          This mode only checks with you before deleting, pushing, sudo, and formatting.
        </p>
        <div className="flex items-center gap-2">
          <button className={ASK_GREEN}>Continue</button>
          <button className="px-3 py-1 text-xs font-medium rounded-lg text-fg-muted hover:text-fg hover:bg-inset transition-colors">
            Don't run
          </button>
        </div>
      </div>
    </FullAutoAskShell>
  );
}

/** R2 — R1·B with the owner's correction: the quiet link becomes a third
 *  button, right of Skip it, behind the header-style `|` divider. The round
 *  varies only the button's orange. Clicking it still opens the same
 *  are-you-sure step — the deny-list consequence confirm is not in question. */
function FullAutoSafetyStopR2({ always }: { always: 'status-orange' | 'mode-amber' | 'ghost' }) {
  const [confirming, setConfirming] = React.useState(false);
  const alwaysClass =
    always === 'status-orange'
      ? `${ASK_BTN} bg-orange-600/60 hover:bg-orange-600/80 text-orange-100`
      : always === 'mode-amber'
        ? ASK_BTN // colors inline below — the chip amber isn't a Tailwind step
        : `${ASK_BTN} border hover:bg-inset`;
  const alwaysStyle =
    always === 'mode-amber'
      ? { backgroundColor: 'rgba(242,179,61,0.35)', color: '#F8D998' }
      : always === 'ghost'
        ? { borderColor: FULL_AUTO_CHIP.border, color: FULL_AUTO_CHIP.color }
        : undefined;
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        {confirming ? (
          <>
            <p className="text-xs font-medium text-fg-2">Always allow this exact command in youcoded?</p>
            <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
              git push origin master
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              It can delete files or change published code, and you won't be asked again.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
              <button className={ASK_RED}>Always allow</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>
              Stopped before pushing code
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              Full auto always checks this first — it changes your published code.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN}>Run it</button>
              <button className={ASK_RED}>Skip it</button>
              <span className="text-fg-faint text-xs select-none">|</span>
              <button className={alwaysClass} style={alwaysStyle} onClick={() => setConfirming(true)}>
                Always Allow
              </button>
            </div>
          </>
        )}
      </div>
    </FullAutoAskShell>
  );
}

/** R3 — R2·A (status orange) with the owner's copy + spacing direction: the
 *  subline tucks under the header as a subheader (2px), the only real gap is
 *  before the buttons (8px). Varies only the subline's verb. */
function FullAutoSafetyStopR3({ copy }: { copy: 'prohibits' | 'stops' | 'limits' }) {
  const [confirming, setConfirming] = React.useState(false);
  const sub =
    copy === 'prohibits'
      // Owner's line, verbatim — punctuation included.
      ? 'YouCoded prohibits this action, even in Full Auto - It changes your published code'
      : copy === 'stops'
        ? 'YouCoded always stops this action, even in Full Auto — it changes your published code.'
        // R4 settled: the owner's third verb, on the normalized punctuation.
        : 'YouCoded limits this action, even in Full Auto — it changes your published code.';
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        {confirming ? (
          <>
            <p className="text-xs font-medium text-fg-2">Always allow this exact command in youcoded?</p>
            <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
              git push origin master
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              It may delete files or change published code, and you won't be asked again during future sessions in this project.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
              <button className={ASK_RED}>Always allow</button>
            </div>
          </>
        ) : (
          <>
            {/* Header + subheader as ONE tight block; the container's space-y-2
                then puts the round's only real gap before the buttons. */}
            <div className="space-y-0.5">
              <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>
                Stopped before pushing code
              </p>
              <p className="text-2xs text-fg-dim leading-relaxed">{sub}</p>
            </div>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN}>Run it</button>
              <button className={ASK_RED}>Skip it</button>
              <span className="text-fg-faint text-xs select-none">|</span>
              <button
                className={`${ASK_BTN} bg-orange-600/60 hover:bg-orange-600/80 text-orange-100`}
                onClick={() => setConfirming(true)}
              >
                Always Allow
              </button>
            </div>
          </>
        )}
      </div>
    </FullAutoAskShell>
  );
}

const ALL_SURFACES: CompareSurface[] = [
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
      {
        n: 4,
        basis: 'R3 · B (Gutter + pencil). Layout settled. Note glyph swapped to a lined PAGE in all three (an instruction, not a question — the old notebook-and-pencil read as "edit" and collided with the corner pencil). Compared: the note text treatment.',
        candidates: [
          {
            id: 'boxed',
            label: 'Note in a container',
            note: 'The note sits in its own bg-well box, one step deeper than the card, so it reads as content the card holds rather than another metadata line. Most structure.',
            render: () => <InDialog><CardNoteBoxed /></InDialog>,
          },
          {
            id: 'quoted',
            label: 'Italic in quotes',
            note: 'Italic, muted, typographic quotes, no box — says "your words" through typography instead of a container, keeping the card as light as R3.',
            render: () => <InDialog><CardNoteQuoted /></InDialog>,
          },
          {
            id: 'plain',
            label: 'Plain, promoted',
            note: 'No box, no quotes — the note is simply the most prominent thing in the card, at full text colour and the chip row\'s size, with the page glyph as the only context.',
            render: () => <InDialog><CardNotePlain /></InDialog>,
          },
        ],
      },
      {
        n: 5,
        basis: 'R4 · B (Italic in quotes). Typography over a container, settled. Open: what a LONG note does — all three use a realistic two-line note, which is what a short fixture could never show.',
        candidates: [
          {
            id: 'one-line',
            label: 'One line (as picked)',
            note: 'Round 4\'s winner, unchanged, against a long note. The card never changes height whatever was written — and about four words get through.',
            render: () => <InDialog><CardQuoteOneLine /></InDialog>,
          },
          {
            id: 'two-lines',
            label: 'Two lines, then ellipsis',
            note: 'Roughly a full sentence lands, and the card still has a ceiling: it can grow by one line and no further. Italic kept.',
            render: () => <InDialog><CardQuoteTwoLines /></InDialog>,
          },
          {
            id: 'full',
            label: 'Unclamped, roman',
            note: 'Nothing you wrote is hidden, at the cost of a card that pushes "Close session" down the dialog. Drops italic — two full lines of it at this size stops being comfortable, and the quotes carry the signal alone.',
            render: () => <InDialog><CardQuoteFull /></InDialog>,
          },
        ],
      },
      {
        n: 6,
        basis: 'R5 · B (two lines, then ellipsis). The card is settled. Open: the EDIT flow — how you get in, whether you can see what you are changing, and how you get out. All three run the real TagPicker and NoteEditor, so they can actually be used.',
        candidates: [
          {
            id: 'replace',
            label: 'Replace in place',
            note: 'What ships today. The card swaps to the editor, a "Done" link swaps it back. Least chrome — but you lose sight of the summary you are editing, and "Done" is a small target for the only way out.',
            render: () => <InDialog><FlowReplace /></InDialog>,
          },
          {
            id: 'expand',
            label: 'Expand beneath',
            note: 'The summary stays as a header and the editor opens under it in the same card, so what you are changing stays visible. Pencil becomes a chevron. Costs height — both are on screen at once.',
            render: () => <InDialog><FlowExpand /></InDialog>,
          },
          {
            id: 'inline',
            label: 'No mode at all',
            note: 'Chips carry an ×, a dashed "+ tag" drops the picker in, the note becomes a field on click. Fewest clicks for a small change; busier at rest, and there is no single "I am done" moment.',
            render: () => <InDialog><FlowInline /></InDialog>,
          },
        ],
      },
      {
        n: 7,
        basis: 'R6 · A (replace in place), with B\'s containment. A dropped the card on the way in — the editor became a bare section on the dialog, so the body changed shape when you clicked. All three keep the SAME card element and swap only its contents. Open: how you get out, since the pencil is gone while editing.',
        candidates: [
          {
            id: 'link',
            label: 'Done link in the corner',
            note: 'The exit sits exactly where the way in was, so the corner is consistently "this card\'s control". Quietest, and the smallest target.',
            render: () => <InDialog><FlowCardLink /></InDialog>,
          },
          {
            id: 'check',
            label: 'Checkmark, swaps the pencil',
            note: 'The corner always holds one control and the glyph says which mode you are in — pencil to edit, check to finish. No words, same target as the pencil.',
            render: () => <InDialog><FlowCardCheck /></InDialog>,
          },
          {
            id: 'button',
            label: 'Full-width Done button',
            note: 'Unmissable and impossible to fumble — but it reads as "commit this section", which is a small lie: nothing commits until the dialog\'s own button. Tallest by a row.',
            render: () => <InDialog><FlowCardButton /></InDialog>,
          },
        ],
      },
      {
        n: 8,
        basis: 'R7 · C (full-width button), with Done → Save on a darker neutral pill (settled, not compared — accent belongs to the dialog\'s own confirm). Compared: tightening the editor, which was 9 stacked bands. All three open in edit mode, since that is what is being judged.',
        candidates: [
          {
            id: 'headers',
            label: 'Merged headers',
            note: 'Labels stop owning their own lines — "Tags" shares its row with "Manage tags…", the note loses its label since the placeholder says it. Same structure, three bands less. Least disruptive.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditTightHeaders d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'applied-first',
            label: 'Applied first, rest as chips',
            note: 'What is already on sits as removable chips up top; below are only the tags that are NOT applied. With three tags on, the list you scan is three rows shorter, and "what does this have" stops being a hunt through checkboxes.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditAppliedFirst d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'one-well',
            label: 'One well, no labels',
            note: 'Tags and note share a single inset container split by a divider, so the editor is one object rather than two sections. Most compact; furthest from the app\'s existing form language.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditOneWell d={d} onSave={save} />} /></InDialog>,
          },
        ],
      },
      {
        n: 9,
        basis: 'R8 · B (applied first, rest as chips) on CONCEPT — what is on sits apart from what is available, as chips rather than checkbox rows. Compared: the mechanic — how a tag is added, removed, and where the available set lives at rest. Note field and Save pill identical throughout.',
        candidates: [
          {
            id: 'token',
            label: 'Token field',
            note: 'Applied chips live inside the input, like an email To: field. Type to filter, Enter adds or creates, Backspace peels the last chip. One control instead of two rows — and it gets the search back that R8·B gave up.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditTokenField d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'plus',
            label: 'Chips + "+" disclosure',
            note: 'At rest you see only what is applied, plus a "+". The available set costs nothing until asked for — tightest resting state, at one extra click per add and a list that appears under your cursor.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditPlusDisclosure d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'columns',
            label: 'On | Available',
            note: 'Both sets always visible side by side; click a chip to move it across. Nothing hidden, nothing toggles, state never in doubt — but it spends horizontal space a 380px dialog does not have, so each column wraps sooner.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditTwoColumns d={d} onSave={save} />} /></InDialog>,
          },
        ],
      },
      {
        n: 10,
        basis: 'Back to R8·B, which was right. Round 9 was the wrong axis — it answered "tighten this" by making the INTERACTION cleverer. These keep R8·B\'s mechanic exactly (click a chip, that is all) and vary only how the chips are ORGANISED.',
        candidates: [
          {
            id: 'one-flow',
            label: 'One flow, dot divider',
            note: 'No two blocks and no rule — applied first, one dot, then the available dimmed, all in a single wrapped run you read left to right. Fewest bands; the boundary is one character, which is either elegant or invisible.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditFlowOne d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'outline',
            label: 'Filled on, outlined off',
            note: 'Two groups still, but the difference is DRAWN rather than faded: applied keep their fill, available are dashed outlines. No divider needed, and a dashed outline reads as "not yet" the way opacity never quite does.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditOutline d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'strip',
            label: 'Fixed-height strip',
            note: 'Applied wraps freely; available is ONE sideways-scrolling row, so the editor\'s height never changes as the tag registry grows — the thing that makes every wrapped cloud worse the longer you use the app. Costs discoverability past the right edge.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditFixedStrip d={d} onSave={save} />} /></InDialog>,
          },
        ],
      },
    ],
  },
  {
    id: 'permissions-mode-control',
    label: 'Permissions — mode control',
    question:
      'Three modes with one safe default and two riskier ones — how should the control present them so the default reads as the default rather than as one of three equals?',
    frame: 'panel',
    // The real width. Settings → Permissions is <Dialog size="panel">, and
    // DIALOG_WIDTHS.panel is min(420px, 88vw) — these definitions wrap here.
    paneWidth: 420,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'radio-list',
            label: 'Radio list',
            note: 'VariantC\'s ?mc=1 and its recommendation. A RadioGroup of SettingRow "item" tiles — the radio sits in the icon slot and the whole tile is the hit target, which is what survives a phone. Tallest, and the definitions get the least width.',
            render: () => <ModePane control={ModeRadioList} />,
          },
          {
            id: 'segmented-key',
            label: 'Segmented + full key',
            note: 'VariantC\'s ?mc=2. The picker is one compact SegmentedTabs row and all three definitions print below it as a fixed, unemphasised key — so the control is small but the reading matter is detached from the thing it describes.',
            render: () => <ModePane control={ModeSegmentedWithKey} />,
          },
          {
            id: 'trailing-radios',
            label: 'Rows, radio on the right',
            note: 'VariantC\'s ?mc=3. Same rows as A with the Radio moved into SettingRow\'s control slot, so each title and its definition get the row\'s full left edge — the difference that only shows up at 420px, where these lines wrap.',
            render: () => <ModePane control={ModeTrailingRadios} />,
          },
        ],
      },
      {
        n: 2,
        basis:
          'R1 — all three, not one of them. They differ on geometry and share the problem: three options of equal weight, equally drawn, in a control where one is the obviously-safe default and the other two are escalations away from it. R2 keeps every mode definition verbatim and varies only the SHAPE of the choice, so a pick names a presentation rather than a sentence. (The inertness the owner objected to is being fixed in the main process — every candidate here takes value/onChange and really owns its value.)',
        candidates: [
          {
            id: 'state-first',
            label: 'State first, Change is a step',
            note: 'At rest this is not a picker: one row states how the assistant behaves now, with a ghost "Change" beside it; that opens the three-option list and choosing closes it again. Reads as a setting with a value. Costs the at-rest comparison of all three definitions — the exact thing VariantC\'s owner review bought back.',
            render: () => <ModePane control={ModeStateFirst} />,
          },
          {
            id: 'step-ups',
            label: 'Default, then the step-ups',
            note: 'All three still visible and readable, but no longer a flat stack: Ask first stands alone, and the two that trade oversight for fewer interruptions are held in one bordered card labelled with what they have in common. Containment, not indent — the same fix that settled the folder cards.',
            render: () => <ModePane control={ModeStepUps} />,
          },
          {
            id: 'scale',
            label: 'A scale, not a row of tabs',
            note: 'Keeps the compact segmented picker — much the smallest form — but reframes it as an axis: the ends are named beneath it, and the key steps one indent further right per mode, so left-to-right and top-to-bottom both mean "less checking". Least chrome; the escalation is carried entirely by layout.',
            render: () => <ModePane control={ModeScale} />,
          },
        ],
      },
      {
        n: 3,
        basis:
          'R1 and R2 BOTH discarded — not one over the other, the whole category. All six candidates were controls (radio lists, segmented tabs, a row with a Change button): "this IS NOT AND SHOULD NOT BE A REAL PERMISSIONS SELECTOR. it still looks like a live selector that changes a setting". Permission mode is per-CONVERSATION state, owned by NativeSessionHost and set from the status-bar chip, so this screen has no app-wide value to write — a control here either does nothing or invents a setting that does not exist. R3 compares PRESENTATIONS OF REFERENCE CONTENT instead: three terms and their definitions as facts, no selected state, nothing clickable, and each one says where the mode is really changed. The axis is containment — its own card, no container, or one shared with the always-asks list.',
        candidates: [
          {
            id: 'quiet-card',
            label: 'Quiet informational card',
            note: 'What the component does today, as the baseline. Three run-in definitions on the same bg-inset/50 card the always-asks list uses — this screen\'s established "fact, not control" surface. The card groups them, so the terms only need weight.',
            render: () => (
              <ReferencePane>
                <ModeRefSections><ModeRefCard /></ModeRefSections>
              </ReferencePane>
            ),
          },
          {
            id: 'definition-list',
            label: 'Definition list, no card',
            note: 'A real <dl>: nothing drawn at all, so there is no box to mistake for a group of options, and a screen reader announces terms and definitions rather than three paragraphs. Without the card the labels have to be the structure, so they take their own line — which also puts the three names in a scannable column.',
            render: () => (
              <ReferencePane>
                <ModeRefSections><ModeRefDefinitions /></ModeRefSections>
              </ReferencePane>
            ),
          },
          {
            id: 'coupled',
            label: 'One explanation, both bands',
            note: 'Modes and the always-asks list share ONE card split by rules. Full auto ends "The list below is the exception" — here that list is inside the same box rather than a section away, so the sentence points at something the eye already reads as part of it. Both headings survive as band headers. Tallest object on the screen, and it breaks the one-section-per-idea rhythm.',
            render: () => (
              <ReferencePane>
                <ModeRefCoupled />
              </ReferencePane>
            ),
          },
        ],
      },
    ],
  },
  {
    id: 'full-auto-ask',
    label: 'Full auto — the destructive-command stop',
    question:
      'The only prompt full auto still shows is the stop before a destructive command — how should that card explain the stop, and which actions belong on it?',
    frame: 'canvas',
    // Chat-column width — the card lives in the timeline, not a dialog.
    paneWidth: 560,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'explained-row',
            label: 'Explain, keep the buttons',
            note: 'Smallest change: today\'s Yes / Always Allow / No survives untouched (muscle memory, arrow-key row, the confirm behind Always Allow), and one amber line above it names why the mode stopped. Cost: three buttons still read as an ordinary "may I?" question, which is the complaint.',
            render: () => <FullAutoExplainedRow />,
          },
          {
            id: 'safety-stop',
            label: 'Safety stop — run it / skip it',
            note: 'The footer becomes the mode\'s own amber surface with two verbs, so it reads as "your agent stopped itself", not a permission quiz. "Always allow" demotes to a quiet line that opens the SAME are-you-sure step as today (click it — it works here). Cost: the rule-making action is easy to miss, on the one mode where it matters most.',
            render: () => <FullAutoSafetyStop />,
          },
          {
            id: 'checkpoint',
            label: 'Checkpoint — chip carries the why',
            note: 'The StatusBar\'s FULL AUTO chip re-appears on the card, the copy restates the mode\'s whole contract, one primary Continue. No way to create an always-allow rule from the card at all — that would move to Settings, which today can only revoke, and the shipped Permissions copy ("an entry switches off the last check") would need rewriting. The honest version of "auto-approve plus acknowledge".',
            render: () => <FullAutoCheckpoint />,
          },
        ],
      },
      {
        n: 2,
        basis:
          'R1 · B (safety stop). Owner correction: the underlined "stop checking this" line is out — the rule-making action returns as a real third button, an orange Always Allow to the right of Skip it with a | between (the header-row pipe). Framing, verbs, and the are-you-sure step behind Always Allow are settled; the round varies only which orange the button wears.',
        candidates: [
          {
            id: 'status-orange',
            label: 'Status orange',
            note: 'bg-orange-600/60, the exact grammar of the green/red/blue buttons one shade-family over — reads as a fourth member of the app\'s permission-button set. Distinct from both the amber band behind it and the blue Always Allow that Ask mode uses.',
            render: () => <FullAutoSafetyStopR2 always="status-orange" />,
          },
          {
            id: 'mode-amber',
            label: 'Mode amber',
            note: 'The FULL AUTO chip\'s own #F2B33D, saturated to button weight — ties the button to the mode identity, at the cost of sitting on an amber band of the same hue (least separation of the three).',
            render: () => <FullAutoSafetyStopR2 always="mode-amber" />,
          },
          {
            id: 'ghost-orange',
            label: 'Outlined orange',
            note: 'Same slot and color family but outlined, no fill — a half-step quieter than Run/Skip, keeping a whisper of R1·B\'s demotion while still being a visible button. Included as the conservative reading; skip if the solid buttons already look right.',
            render: () => <FullAutoSafetyStopR2 always="ghost" />,
          },
        ],
      },
      {
        n: 3,
        basis:
          'R2 · A (status orange). Layout, verbs, and the orange are settled. Owner direction: subline copy becomes "YouCoded prohibits this action…" and tightens under the header as a subheader — the only real space sits before the buttons. Compared: the VERB. "Prohibits" claims the app forbids what the green button one line down will run — the same shape of claim the Permissions screen walked back ("cannot be turned off" was false). A is the direction verbatim; B keeps the sentence but says what actually happens.',
        candidates: [
          {
            id: 'prohibits',
            label: '"Prohibits" (verbatim)',
            note: 'The owner\'s line untouched. Strongest wording — but the card itself offers Run it and Always Allow, so "prohibits" is contradicted two centimetres below the word.',
            render: () => <FullAutoSafetyStopR3 copy="prohibits" />,
          },
          {
            id: 'always-stops',
            label: '"Always stops"',
            note: 'Same sentence shape, accurate verb: the app always STOPS the action for your say-so, which is exactly what the card is doing. Punctuation normalized to the app\'s em-dash style.',
            render: () => <FullAutoSafetyStopR3 copy="stops" />,
          },
        ],
      },
      {
        n: 4,
        basis:
          'R3 — neither pane verbatim; the owner supplied a third verb, "limits". Settled line: "YouCoded limits this action, even in Full Auto — it changes your published code." on the normalized punctuation. Nothing left to compare — this round IS the record of the settled card.',
        candidates: [
          {
            id: 'settled',
            label: 'Settled',
            note: 'R2·A layout (Run it / Skip it | Always Allow in status orange), R3 subheader spacing, the "limits" line. The card that goes to spec.',
            render: () => <FullAutoSafetyStopR3 copy="limits" />,
          },
        ],
      },
    ],
  },
];

// CompareView opens on COMPARE_SURFACES[0] and has no URL param for the surface,
// so whichever entry is first is the one a plain ?view=compare lands on. Order by
// what is under active design rather than by authoring order — otherwise every
// visit starts with a dropdown hunt for the round actually being worked on.
const ACTIVE_FIRST = 'full-auto-ask';

export const COMPARE_SURFACES: CompareSurface[] = [
  ...ALL_SURFACES.filter((s) => s.id === ACTIVE_FIRST),
  ...ALL_SURFACES.filter((s) => s.id !== ACTIVE_FIRST),
];
