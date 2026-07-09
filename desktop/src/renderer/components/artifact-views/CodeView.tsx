import MarkdownContent from '../MarkdownContent';
import type { ArtifactViewProps } from './types';

export function CodeView({ path, content }: ArtifactViewProps) {
  if (content === null) {
    return <div className="text-fg-muted p-4">This file is no longer on disk.</div>;
  }
  const lang = path.split('.').pop() ?? '';
  // Reuses the chat markdown highlighter by wrapping in a fenced code block.
  const wrapped = '```' + lang + '\n' + content + '\n```';
  return (
    <div className="overflow-auto p-4 h-full">
      <MarkdownContent content={wrapped} />
    </div>
  );
}
