export interface ArtifactViewProps {
  path: string;
  content: string | null;
  absolutePath: string;
  isEditable: boolean;
  onEdit?: (newContent: string) => void;
  // Task 6.4: controlled edit-mode props lifted from MarkdownView into
  // ActiveArtifactView so the conflict banner can manage edit state.
  // Optional — non-editing viewers (Code, Image, etc.) safely ignore them.
  editing?: boolean;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}
