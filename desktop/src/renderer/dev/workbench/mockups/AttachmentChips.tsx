// src/renderer/dev/workbench/mockups/AttachmentChips.tsx
//
// DESIGN MOCK-UP, not a shipping feature. Three candidate designs for the
// composer's attachment chips (InputBar.tsx, the row above the input box),
// rendered side by side over the same eleven sample files so Destin can pick
// one. Nothing here is wired into InputBar; when a design is chosen the
// winning component moves out of dev/ and the rest is deleted.
//
// WHY three: the current 48×48 square chip cuts a document name to "design…"
// at 9px, shows a broken image when a thumbnail can't load, and hides the
// remove ✕ until hover. Destin's direction (2026-08-27): "name should be a
// small strip at the bottom of the card and we should render a preview for
// most filetypes probably if cheap, or at least for basic image/markdown/etc".
// A is the cheap text-only floor, B is his direction at today's footprint,
// C is B scaled up until the text preview is actually readable.
//
// Reached at ?mode=workbench&child=1&view=attachments (routing in index.tsx).
// Dev-only, like the rest of dev/.

import React from 'react';
import { Button } from '../../../components/ui/Button';
import { fileTypeGroup } from '../../../../shared/artifacts/categorization';
import { DocIcon, ImageIcon, SheetIcon, CodeGlyphIcon } from '../../../components/project-view/icons';

// ── Sample attachments ───────────────────────────────────────────────────────
// One per kind we have to handle. `kind` is the test hook (data-kind on every
// chip); `name` is what the user sees. The image uses a data-URI SVG so the
// thumbnail really renders in a browser tab — the shipping version reads
// `file://` like today's chip does.

type SampleKind =
  | 'image' | 'markdown' | 'text' | 'code' | 'pdf' | 'spreadsheet'
  | 'audio' | 'video' | 'archive' | 'long-name' | 'unknown';

interface SampleAttachment {
  kind: SampleKind;
  name: string;
  /** Preview source for images (data URI here; file:// when shipped). */
  src?: string;
  /** First few lines of a text-like file. In the shipping version this comes
   *  from a cheap head-read of the file (first ~512 bytes over IPC) at attach
   *  time, cached on the Attachment — never the whole file. */
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

// ── File-type classification ─────────────────────────────────────────────────
// The app already has ONE extension→group mapping: fileTypeGroup() in
// shared/artifacts/categorization.ts (image / sheet / document / code), whose
// icons live in project-view/icons.tsx and are picked by FilesTab's
// MiniTypeIcon. Reused here rather than re-invented. It has no pdf / audio /
// video / archive buckets (everything unknown falls to 'code'), so this file
// layers those on top by extension. If a card design ships, this refinement
// belongs in categorization.ts next to fileTypeGroup, not here.

type ChipType = 'image' | 'sheet' | 'document' | 'code' | 'text' | 'pdf' | 'audio' | 'video' | 'archive' | 'unknown';

const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar']);
const TEXT_EXTS = new Set(['md', 'markdown', 'txt']);
// Extensions categorization.ts already knows as code — anything else that
// lands in its 'code' bucket is really "unknown" for chip purposes.
const KNOWN_CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'kt', 'java', 'rs', 'go', 'rb', 'sh',
  'json', 'yaml', 'yml', 'toml', 'css', 'scss', 'sql', 'c', 'h', 'cpp', 'cs', 'swift', 'log',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function chipType(name: string): ChipType {
  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (TEXT_EXTS.has(ext)) return 'text';
  const group = fileTypeGroup(name);
  if (group === 'code') return KNOWN_CODE_EXTS.has(ext) ? 'code' : 'unknown';
  return group;
}

// ── Icons ────────────────────────────────────────────────────────────────────
// Same lucide-style stroke convention as project-view/icons.tsx (24-box,
// currentColor, round caps). Image / sheet / doc / code come from that file;
// the rest are mock-up-local glyphs for the buckets it doesn't have.

interface IconProps { size?: number; strokeWidth?: number }

function base(size: number, strokeWidth: number) {
  return {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
}

function TextLinesIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <path d="M8 13h8" /><path d="M8 17h8" />
    </svg>
  );
}

function PdfIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <path d="M9 18v-6h2a2 2 0 0 1 0 4H9" />
    </svg>
  );
}

function AudioIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    </svg>
  );
}

function VideoIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 9h20" /><path d="M2 15h20" /><path d="M7 4v16" /><path d="M17 4v16" />
    </svg>
  );
}

function ArchiveIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" />
    </svg>
  );
}

function UnknownFileIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <path d="M10 12.5a2 2 0 1 1 2.5 2c-.4.2-.5.5-.5 1" /><path d="M12 18h.01" />
    </svg>
  );
}

function TypeIcon({ type, size }: { type: ChipType; size: number }) {
  switch (type) {
    case 'image': return <ImageIcon size={size} />;
    case 'sheet': return <SheetIcon size={size} />;
    case 'code': return <CodeGlyphIcon size={size} />;
    case 'text': return <TextLinesIcon size={size} />;
    case 'pdf': return <PdfIcon size={size} />;
    case 'audio': return <AudioIcon size={size} />;
    case 'video': return <VideoIcon size={size} />;
    case 'archive': return <ArchiveIcon size={size} />;
    case 'unknown': return <UnknownFileIcon size={size} />;
    default: return <DocIcon size={size} />;
  }
}

// ── Shared bits ──────────────────────────────────────────────────────────────

/** The ✕. Same 16px geometry as today's chip (spec §11.8 F, InputBar.tsx),
 *  minus the hover-only opacity — every design here keeps it always visible,
 *  which is the one thing all three have in common. `onCard` adds a panel
 *  fill + border so it stays legible over an image thumbnail. */
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

/** First lines of a text-like file, clipped to the preview box. Code gets
 *  mono; in this app every font is mono already, so the class is there for
 *  the day that changes. */
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
function GlyphPreview({ type, ext, iconSize, textClass }: { type: ChipType; ext: string; iconSize: number; textClass: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-0.5 text-fg-muted">
      <TypeIcon type={type} size={iconSize} />
      <span className={`${textClass} uppercase tracking-wide`}>{ext || 'file'}</span>
    </div>
  );
}

// ── Design A: wide chip ──────────────────────────────────────────────────────
// One-line pill, ~28px tall: icon · name (ellipsis after ~16 characters, full
// name in the tooltip) · ✕. Zero preview cost — the answer if "cheap" wins.

function WideChip({ att }: { att: SampleAttachment }) {
  const type = chipType(att.name);
  return (
    <div
      data-kind={att.kind}
      title={att.name}
      className="inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-full border border-edge bg-panel text-fg-2 text-xs shrink-0"
    >
      <span className="text-fg-dim shrink-0"><TypeIcon type={type} size={13} /></span>
      <span className="truncate max-w-[16ch] text-fg">{att.name}</span>
      <RemoveButton name={att.name} />
    </div>
  );
}

// ── Design B: card with name strip (Destin's direction) ──────────────────────
// 96×72 card, md radius. Preview on top; name in an 11px strip along the
// bottom with the type icon at its left; ✕ always on, top-right.

function CardChip({ att, big }: { att: SampleAttachment; big: boolean }) {
  const type = chipType(att.name);
  const ext = extensionOf(att.name);
  const textLike = att.head !== undefined;
  return (
    <div
      data-kind={att.kind}
      title={att.name}
      className={`relative shrink-0 rounded-md border border-edge bg-panel overflow-hidden flex flex-col ${big ? 'w-32 h-24' : 'w-24 h-18'}`}
    >
      <div className="flex-1 min-h-0 bg-inset overflow-hidden">
        {att.src ? (
          <img src={att.src} alt="" className="w-full h-full object-cover" />
        ) : textLike ? (
          <HeadPreview head={att.head!} mono={type === 'code'} textClass={big ? 'text-3xs' : 'text-4xs'} />
        ) : (
          <GlyphPreview type={type} ext={ext} iconSize={big ? 28 : 22} textClass={big ? 'text-3xs' : 'text-4xs'} />
        )}
      </div>
      <div className={`flex items-center gap-1 px-1.5 border-t border-edge bg-panel text-fg ${big ? 'h-5 text-xs' : 'h-4 text-2xs'}`}>
        <span className="text-fg-dim shrink-0"><TypeIcon type={type} size={big ? 12 : 10} /></span>
        <span className="truncate min-w-0">{att.name}</span>
      </div>
      <RemoveButton name={att.name} onCard />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/** The row exactly as InputBar lays it out today (`flex gap-2 px-3 py-2
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
        <h1 className="text-lg font-semibold">Attachment chips — three candidates</h1>
        <p className="text-xs text-fg-dim">
          Same eleven files in every row. Today's chip is a 48×48 square with the name at 9px and a hover-only ✕.
        </p>
      </div>
      <Section
        id="a"
        heading="A — Wide chip"
        note="One-line pill, ~28px tall. Type icon, name cut after ~16 characters (full name on hover), ✕ always visible. No preview."
        render={(att) => <WideChip att={att} />}
      />
      <Section
        id="b"
        heading="B — Card with name strip"
        note="96×72 card. Preview on top (image thumbnail, first lines of text/markdown/code, or a big type glyph with the extension); name in an 11px strip along the bottom; ✕ always visible."
        render={(att) => <CardChip att={att} big={false} />}
      />
      <Section
        id="c"
        heading="C — Card, bigger"
        note="Same as B at 128×96 so the text preview is readable; name strip at 12px."
        render={(att) => <CardChip att={att} big />}
      />
    </div>
  );
}
