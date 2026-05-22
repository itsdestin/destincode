// desktop/src/renderer/components/artifact-views/RendererRegistry.ts
import { ComponentType } from 'react';
import { MarkdownView } from './MarkdownView';
import { CodeView } from './CodeView';
import { ImageView } from './ImageView';
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
  // @ts-expect-error PdfView created in Task 4.5
  pdf: { lazy: () => import('./PdfView').then((m) => ({ default: m.PdfView })) },
  // @ts-expect-error DocxView created in Task 4.6
  docx: { lazy: () => import('./DocxView').then((m) => ({ default: m.DocxView })) },
  // @ts-expect-error XlsxView created in Task 4.7
  xlsx: { lazy: () => import('./XlsxView').then((m) => ({ default: m.XlsxView })) },
};

export function getViewer(path: string): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return REGISTRY[ext] ?? BinaryFallback;
}
