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
  // When true the viewer renders content/editor only — the Edit / Save / Cancel
  // controls live elsewhere (the SessionDrawer header toolbar drives them via
  // the onStartEdit/onSaveEdit/onCancelEdit callbacks). ProjectView leaves this
  // unset and keeps the in-viewer buttons.
  hideControls?: boolean;
}
