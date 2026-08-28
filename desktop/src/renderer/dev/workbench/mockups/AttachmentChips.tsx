// src/renderer/dev/workbench/mockups/AttachmentChips.tsx
//
// The composer's attachment-chip candidates, side by side over the same
// eleven sample files. Destin picked C on 2026-08-27 (ledger P-19); it now
// ships as components/AttachmentChip.tsx and section C below renders THAT
// component, so this page cannot drift from the composer. A and B stay as
// the mock-ups they were, for the record of what was rejected and why.
//
// WHY three: the old 48×48 square chip cut a document name to "design…" at
// 9px, showed a broken image when a thumbnail couldn't load, and hid the
// remove ✕ until hover. Destin's direction: "name should be a small strip at
// the bottom of the card and we should render a preview for most filetypes
// probably if cheap, or at least for basic image/markdown/etc" — and, once
// C was picked, "render with proper markdown styling instead of being able to
// see the ## and whatever else".
//
// The file-kind mapping and its glyphs moved out of here when C shipped:
// shared/artifacts/categorization.ts (fileKind / previewKind) and
// project-view/icons.tsx (FileKindIcon). A and B read from those too.
//
// Reached at ?mode=workbench&child=1&view=attachments (routing in index.tsx).
// Dev-only, like the rest of dev/.

import React from 'react';
import { Button } from '../../../components/ui/Button';
import { AttachmentChip } from '../../../components/AttachmentChip';
import { fileExtension, fileKind, type FileKind } from '../../../../shared/artifacts/categorization';
import { FileKindIcon } from '../../../components/project-view/icons';

// ── Sample attachments ───────────────────────────────────────────────────────
// One per kind we have to handle. `kind` is the test hook (data-kind on every
// chip); `name` is what the user sees. The image uses a data-URI SVG so the
// thumbnail really renders in a browser tab — the shipping chip reads
// `file://`, and takes this as an `imageSrc` override only here and in tests.

type SampleKind =
  | 'image' | 'markdown' | 'text' | 'code' | 'pdf' | 'spreadsheet'
  | 'audio' | 'video' | 'archive' | 'long-name' | 'unknown';

interface SampleAttachment {
  kind: SampleKind;
  name: string;
  /** Preview source for images (data URI here; file:// when shipped). */
  src?: string;
  /** First lines of a text-like file, for the A/B mock-ups. The shipping
   *  chip (C) reads its own head over fs:read-head — in the workbench the
   *  mock shim answers with canned text per file kind. */
  head?: string;
}

// A small landscape so the thumbnail has recognisable content at 96px. Plain
// SVG shapes; the colours are the sample's own pixels, not UI chrome, so they
// are deliberately not theme tokens (a real screenshot wouldn't be either).
const SAMPLE_IMAGE = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">'
  + '<rect width="160" height="120" fill="#8fbcd4"/>'
  + '<circle cx="120" cy="34" r="16" fill="#f6e7a1"/>'
  + '<path d="M0 90 Q40 60 80 84 T160 78 V120 H0Z" fill="#5f9a62"/>'
  + '<path d="M0 104 Q50 86 100 100 T160 96 V120 H0Z" fill="#3f7a45"/>'
  + '</svg>',
);

export const SAMPLE_ATTACHMENTS: readonly SampleAttachment[] = [
  { kind: 'image', name: 'screenshot.png', src: SAMPLE_IMAGE },
  { kind: 'markdown', name: 'README.md',
    head: '# Attachment chips\n\nThree candidate designs\nfor the composer row.\n- wide pill\n- card' },
  { kind: 'text', name: 'notes.txt',
    head: 'Call Sam about the venue\nOrder 40 chairs\nConfirm catering by Fri\nPrint name tags' },
  { kind: 'code', name: 'InputBar.ts',
    head: 'interface Attachment {\n  path: string;\n  name: string;\n  isImage: boolean;\n}' },
  { kind: 'pdf', name: 'invoice.pdf' },
  { kind: 'spreadsheet', name: 'budget-2026.xlsx' },
  { kind: 'audio', name: 'voice-memo.mp3' },
  { kind: 'video', name: 'demo.mp4' },
  { kind: 'archive', name: 'assets.zip' },
  { kind: 'long-name', name: 'quarterly-marketing-report-final-v3.docx' },
  { kind: 'unknown', name: 'sensor-log.dat' },
];

/** Where the shipping chip pretends each sample lives. The mock fs.readHead
 *  keys its canned text off the extension, so any folder works. */
function samplePath(att: SampleAttachment): string {
  return `/home/destin/Documents/${att.name}`;
}

// ── Shared bits (A and B) ────────────────────────────────────────────────────

/** The ✕. Same 16px geometry as the shipping chip, minus nothing — every
 *  design here keeps it always visible, which is the one thing all three have
 *  in common. `onCard` adds a panel fill + border so it stays legible over an
 *  image thumbnail. */
function RemoveButton({ name, onCard }: { name: string; onCard?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Remove ${name}`}
      onClick={() => { /* mock-up: nothing to remove */ }}
      className={
        'w-4 h-4 rounded-full text-3xs leading-none text-fg-2 hover:bg-edge '
        + (onCard ? 'absolute top-1 right-1 bg-panel border border-edge' : 'shrink-0 bg-inset')
      }
    >
      ×
    </Button>
  );
}

/** First lines of a text-like file, clipped to the preview box — RAW, which
 *  is exactly the thing the shipping card (C) no longer does for markdown. */
function HeadPreview({ head, mono, textClass }: { head: string; mono: boolean; textClass: string }) {
  return (
    <pre
      className={`${textClass} ${mono ? 'font-mono' : 'font-sans'} text-fg-dim leading-tight whitespace-pre overflow-hidden h-full px-1.5 pt-1 text-left`}
    >
      {head}
    </pre>
  );
}

/** Big type glyph + extension in caps — the fallback preview for anything we
 *  can't cheaply render. */
function GlyphPreview({ kind, ext, iconSize, textClass }: { kind: FileKind; ext: string; iconSize: number; textClass: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-0.5 text-fg-muted">
      <FileKindIcon kind={kind} size={iconSize} />
      <span className={`${textClass} uppercase tracking-wide`}>{ext || 'file'}</span>
    </div>
  );
}

// ── Design A: wide chip (rejected) ───────────────────────────────────────────
// One-line pill, ~28px tall: icon · name (ellipsis after ~16 characters, full
// name in the tooltip) · ✕. Zero preview cost.

function WideChip({ att }: { att: SampleAttachment }) {
  const kind = fileKind(att.name);
  return (
    <div
      data-kind={att.kind}
      title={att.name}
      className="inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-full border border-edge bg-panel text-fg-2 text-xs shrink-0"
    >
      <span className="text-fg-dim shrink-0"><FileKindIcon kind={kind} size={13} /></span>
      <span className="truncate max-w-[16ch] text-fg">{att.name}</span>
      <RemoveButton name={att.name} />
    </div>
  );
}

// ── Design B: card with name strip, small (rejected for C) ───────────────────
// 96×72 card, md radius. Preview on top; name in an 11px strip along the
// bottom with the type icon at its left; ✕ always on, top-right.

function CardChip({ att }: { att: SampleAttachment }) {
  const kind = fileKind(att.name);
  const ext = fileExtension(att.name);
  const textLike = att.head !== undefined;
  return (
    <div
      data-kind={att.kind}
      title={att.name}
      className="relative shrink-0 rounded-md border border-edge bg-panel overflow-hidden flex flex-col w-24 h-18"
    >
      <div className="flex-1 min-h-0 bg-inset overflow-hidden">
        {att.src ? (
          <img src={att.src} alt="" className="w-full h-full object-cover" />
        ) : textLike ? (
          <HeadPreview head={att.head!} mono={kind === 'code'} textClass="text-4xs" />
        ) : (
          <GlyphPreview kind={kind} ext={ext} iconSize={22} textClass="text-4xs" />
        )}
      </div>
      <div className="flex items-center gap-1 px-1.5 border-t border-edge bg-panel text-fg h-4 text-2xs">
        <span className="text-fg-dim shrink-0"><FileKindIcon kind={kind} size={10} /></span>
        <span className="truncate min-w-0">{att.name}</span>
      </div>
      <RemoveButton name={att.name} onCard />
    </div>
  );
}

// ── Design C: the shipping card ──────────────────────────────────────────────
// components/AttachmentChip.tsx itself. The data-kind hook the tests and the
// screenshot rig use goes on a display:contents wrapper so the chip's own
// markup is byte-for-byte what the composer renders.

function ShippingChip({ att }: { att: SampleAttachment }) {
  return (
    <span data-kind={att.kind} className="contents">
      <AttachmentChip
        path={samplePath(att)}
        name={att.name}
        imageSrc={att.src}
        onRemove={() => { /* mock-up: nothing to remove */ }}
      />
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/** The row exactly as InputBar lays it out (`flex gap-2 px-3 py-2
 *  overflow-x-auto`), so scroll behaviour in the 390px box is the real thing. */
function Row({ render }: { render: (att: SampleAttachment) => React.ReactNode }) {
  return (
    <div className="flex gap-2 px-3 py-2 overflow-x-auto bg-inset rounded-lg border border-edge-dim">
      {SAMPLE_ATTACHMENTS.map((att) => <React.Fragment key={att.name}>{render(att)}</React.Fragment>)}
    </div>
  );
}

function Section({ id, heading, note, render }: {
  id: string; heading: string; note: string; render: (att: SampleAttachment) => React.ReactNode;
}) {
  return (
    <section data-testid={`mock-${id}`} className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-fg">{heading}</h2>
        <p className="text-xs text-fg-dim">{note}</p>
      </div>
      <Row render={render} />
      <div>
        <p className="text-2xs text-fg-muted mb-1">Same row at 390px (phone width)</p>
        {/* 390px box so horizontal overflow/scroll is visible at a glance.
            Fixed width on purpose: the workbench iframe is wide. */}
        <div className="w-[390px] max-w-full">
          <Row render={render} />
        </div>
      </div>
    </section>
  );
}

export function AttachmentChipsMockup() {
  return (
    <div className="min-h-screen bg-canvas text-fg p-6 flex flex-col gap-8 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold">Attachment chips — candidates and the one that shipped</h1>
        <p className="text-xs text-fg-dim">
          Same eleven files in every row. The old chip was a 48×48 square with the name at 9px and a hover-only ✕. C shipped 2026-08-27.
        </p>
      </div>
      <Section
        id="a"
        heading="A — Wide chip"
        note="Rejected. One-line pill, ~28px tall. Type icon, name cut after ~16 characters (full name on hover), ✕ always visible. No preview."
        render={(att) => <WideChip att={att} />}
      />
      <Section
        id="b"
        heading="B — Card with name strip"
        note="Rejected. 96×72 card. Preview on top (image thumbnail, RAW first lines of text/markdown/code, or a big type glyph with the extension); name in an 11px strip along the bottom; ✕ always visible."
        render={(att) => <CardChip att={att} />}
      />
      <Section
        id="c"
        heading="C — Card, bigger"
        note="SHIPPED — this is the real composer chip. 128×96 so the preview is readable; markdown is rendered (headings, bold, lists), text/code in a mono block; name strip at 12px."
        render={(att) => <ShippingChip att={att} />}
      />
    </div>
  );
}
