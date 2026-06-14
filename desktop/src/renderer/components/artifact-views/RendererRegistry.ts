// desktop/src/renderer/components/artifact-views/RendererRegistry.ts
import { ComponentType } from 'react';
import { MarkdownView } from './MarkdownView';
import { CodeView } from './CodeView';
import { ImageView } from './ImageView';
import { HtmlView } from './HtmlView';
import { BinaryFallback } from './BinaryFallback';
import type { ArtifactViewProps } from './types';

export type { ArtifactViewProps } from './types';

type LazyImporter = () => Promise<{ default: ComponentType<ArtifactViewProps> }>;
type ViewSpec = ComponentType<ArtifactViewProps> | { lazy: LazyImporter };

const REGISTRY: Record<string, ViewSpec> = {
  md: MarkdownView,
  markdown: MarkdownView,
  txt: MarkdownView, // shares the textarea path
  ts: CodeView,
  tsx: CodeView,
  js: CodeView,
  jsx: CodeView,
  py: CodeView,
  css: CodeView,
  json: CodeView,
  yaml: CodeView,
  yml: CodeView,
  png: ImageView,
  jpg: ImageView,
  jpeg: ImageView,
  gif: ImageView,
  webp: ImageView,
  html: HtmlView,
  htm: HtmlView,
  pdf: { lazy: () => import('./PdfView').then((m) => ({ default: m.PdfView })) },
  docx: { lazy: () => import('./DocxView').then((m) => ({ default: m.DocxView })) },
  xlsx: { lazy: () => import('./XlsxView').then((m) => ({ default: m.XlsxView })) },
};

export function getViewer(path: string): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return REGISTRY[ext] ?? BinaryFallback;
}
