export const SIDECAR_SCHEMA_VERSION = 1;
export const INDEX_SCHEMA_VERSION = 1;

export type ArtifactKind = 'internal' | 'external';
export type ArtifactStatus = 'active' | 'deleted';
export type VersionAuthor = 'agent' | 'user';
export type VersionType = 'create' | 'edit' | 'delete';

export interface VersionEvent {
  id: string;            // ULID
  ts: string;            // ISO 8601
  sessionId: string;
  type: VersionType;
  author: VersionAuthor;
}

export interface ArtifactRecord {
  id: string;            // ULID
  path: string;          // canonical, relative if kind='internal'
  kind: ArtifactKind;
  absolutePath: string | null;  // canonical, set when kind='external'
  lastModified: string;  // cache, advisory
  status: ArtifactStatus; // cache, derived from latest version
  versions: VersionEvent[];
  comments: unknown[];    // empty in v1
  tags: string[];         // empty in v1
}

export interface ManualInclude {
  path: string;          // canonical absolute
  addedAt: string;
  addedBy: 'user';
}

export interface ProjectSidecar {
  $schema: typeof SIDECAR_SCHEMA_VERSION;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  artifacts: ArtifactRecord[];
  manualExcludes: string[];     // canonical paths
  manualIncludes: ManualInclude[];
}

export interface CentralIndexProject {
  id: string;
  name: string;
  path: string;           // canonical absolute
  lastIndexed: string;
  lastSession: string | null;
  contentTypes: ('artifacts' | 'conversations')[];
  stats: { artifactCount: number };
}

export interface CentralIndex {
  $schema: typeof INDEX_SCHEMA_VERSION;
  projects: CentralIndexProject[];
}
