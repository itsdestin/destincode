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

export function getViewer(path: string, opts?: { textHint?: boolean }): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const hit = REGISTRY[ext];
  if (hit) return hit;
  // D4: an unknown extension is no longer an automatic BinaryFallback. When the
  // artifacts:get response sniffed the bytes as TEXT (binary:false), route to
  // CodeView so rs/go/kt/sh/sql/toml/… and extensionless files render — and
  // edit — as code. No hint (older callers, pre-fetch renders) keeps the old
  // conservative fallback.
  if (opts?.textHint) return CodeEditorView;
  return BinaryFallback;
}
