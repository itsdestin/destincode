export interface ArtifactViewProps {
  path: string;
  content: string | null;
  absolutePath: string;
  isEditable: boolean;
  onEdit?: (newContent: string) => void;
}
