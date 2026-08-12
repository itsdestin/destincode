// desktop/src/renderer/components/artifact-views/RendererRegistry.ts
import { ComponentType, lazy } from 'react';
import { MarkdownView } from './MarkdownView';
import { CsvView } from './CsvView';
import { ImageView } from './ImageView';
import { HtmlView } from './HtmlView';
import { BinaryFallback } from './BinaryFallback';
import type { ArtifactViewProps } from './types';

export type { ArtifactViewProps } from './types';

type ViewSpec = ComponentType<ArtifactViewProps>;

// Heavy viewers (pdfjs / mammoth / SheetJS) are code-split via React.lazy so
// their bundles only load when a file of that type is opened. The Registry now
// returns a real component for every entry — ActiveArtifactView wraps the render
// in a <Suspense> boundary so the lazy ones resolve transparently.
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })));
// CodeMirror editor — lazy like the other heavy viewers (~150KB + per-language
// chunks); ViewerErrorBoundary is REQUIRED around the render because lazy()
// THROWS chunk-load rejections (a real Android-offline failure mode).
const CodeEditorView = lazy(() => import('./CodeEditorView').then((m) => ({ default: m.CodeEditorView })));
const DocxView = lazy(() => import('./DocxView').then((m) => ({ default: m.DocxView })));
const XlsxView = lazy(() => import('./XlsxView').then((m) => ({ default: m.XlsxView })));

const REGISTRY: Record<string, ViewSpec> = {
  md: MarkdownView,
  markdown: MarkdownView,
  txt: MarkdownView, // shares the textarea path
  ts: CodeEditorView,
  tsx: CodeEditorView,
  js: CodeEditorView,
  jsx: CodeEditorView,
  py: CodeEditorView,
  css: CodeEditorView,
  json: CodeEditorView,
  yaml: CodeEditorView,
  yml: CodeEditorView,
  png: ImageView,
  jpg: ImageView,
  jpeg: ImageView,
  gif: ImageView,
  webp: ImageView,
  bmp: ImageView,
  ico: ImageView,
  avif: ImageView,
  html: HtmlView,
  htm: HtmlView,
  svg: ImageView,
  pdf: PdfView,
  docx: DocxView,
  xlsx: XlsxView,
  // CSV/TSV are extremely common agent output — a spreadsheet-style grid, not
  // a code dump. (Text path: content prop, no binary IPC.)
  csv: CsvView,
  tsv: CsvView,
};

/**
 * The component that renders EDIT mode. Distinct from getViewer because most
 * read-mode viewers have no edit UI at all — HtmlView is an iframe preview,
 * CsvView a grid — so "Edit" on those files rendered nothing (found in
 * review). md/markdown/txt keep MarkdownView's textarea (plan decision);
 * every other editable text file edits in the CodeMirror editor, whatever
 * its read-mode presentation is.
 */
export function getEditViewer(path: string): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return MarkdownView;
  return CodeEditorView;
}

// Fix: a text-extension file whose BYTES sniffed binary (a .md or .ts holding
// NUL bytes) resolves from artifacts:get as content:null + binary:true. These
// viewers render from the text `content` prop, so routing them by extension
// showed a silent blank pane — they must fall back to BinaryFallback instead.
// HtmlView belongs here too: it also renders from `content` (srcDoc), and with
// null content it shows a PERPETUAL "Loading…" — an unresolvable claim, worse
// than blank (error-message-standards). Real binary viewers (Image/Pdf/Docx/
// Xlsx) read their own bytes from disk and keep extension routing.
const TEXT_CONTENT_VIEWERS: ReadonlySet<ViewSpec> = new Set([MarkdownView, CodeEditorView, CsvView, HtmlView]);

export function getViewer(path: string, opts?: { textHint?: boolean; binaryHint?: boolean }): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const hit = REGISTRY[ext];
  if (hit) {
    // Sniffed-binary override for text viewers only — see TEXT_CONTENT_VIEWERS.
    if (opts?.binaryHint && TEXT_CONTENT_VIEWERS.has(hit)) return BinaryFallback;
    return hit;
  }
  // D4: an unknown extension is no longer an automatic BinaryFallback. When the
  // artifacts:get response sniffed the bytes as TEXT (binary:false), route to
  // CodeView so rs/go/kt/sh/sql/toml/… and extensionless files render — and
  // edit — as code. No hint (older callers, pre-fetch renders) keeps the old
  // conservative fallback.
  if (opts?.textHint) return CodeEditorView;
  return BinaryFallback;
}
