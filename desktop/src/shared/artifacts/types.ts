export const SIDECAR_SCHEMA_VERSION = 1;
export const INDEX_SCHEMA_VERSION = 1;

export type ArtifactKind = 'internal' | 'external';
export type ArtifactStatus = 'active' | 'deleted';
export type VersionAuthor = 'agent' | 'user';
// 'read' marks a document Claude opened (Read tool) but did not modify — it
// makes the file appear as a session artifact so it's openable from the tool
// card, without fabricating fake edit history. Only document-type files get a
// 'read' version (see the artifact tracker in App.tsx); code/config reads are
// not tracked.
export type VersionType = 'create' | 'edit' | 'delete' | 'read';

export interface VersionEvent {
  id: string;            // ULID
  ts: string;            // ISO 8601
  sessionId: string;
  type: VersionType;
  author: VersionAuthor;
}

export interface ArtifactRecord {
  id: string;            // ULID (tracked) OR canonical relative path (discovered)
  path: string;          // canonical, relative if kind='internal'
  kind: ArtifactKind;
  absolutePath: string | null;  // canonical, set when kind='external'
  lastModified: string;  // cache, advisory
  status: ArtifactStatus; // cache, derived from latest version
  versions: VersionEvent[];
  comments: unknown[];    // empty in v1
  tags: string[];         // empty in v1
  // Synthesized at list time for files found on disk that Claude never tracked
  // (on-disk document discovery). NEVER persisted to the sidecar. Consumers must
  // treat discovered files as always-present (skip orphan/existence checks) and
  // resolve their content by PATH (id == canonical relative path), not by sidecar
  // lookup.
  discovered?: boolean;
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

// Max length of a user-written project description. Enforced in BOTH setters
// (synced registry + saved folders) and as maxLength on the input, so a pasted
// document can never bloat a file that syncs to every device.
export const PROJECT_DESCRIPTION_MAX = 200;

export interface CentralIndexProject {
  id: string;
  name: string;
  path: string;           // canonical absolute
  lastIndexed: string;
  lastSession: string | null;
  contentTypes: ('artifacts' | 'conversations')[];
  // ARTIFACTS count — files Claude directly created/edited (tracked). In the fast
  // (no-withCounts) list this is the cheap sidecar count; withCounts makes it the
  // authoritative non-deleted, on-disk artifact count.
  stats: { artifactCount: number };
  // Computed at list time (only when LIST_PROJECTS_INDEX is called withCounts) —
  // NOT persisted to the index. Powers the project switcher's "files · chats" hint.
  // fileCount = ALL FILES (the project folder's on-disk documents — the full-browser
  // count), distinct from stats.artifactCount above. conversationCount = number of
  // past sessions in the folder.
  fileCount?: number;
  // True when discovery hit a cap computing fileCount — the UI renders "N+"
  // instead of letting a truncated sample pose as an exact total. Gated roots
  // (home dir / drive root) get NO fileCount at all (no scan runs there).
  fileCountTruncated?: boolean;
  conversationCount?: number;
  // The LOCAL-folder description, overlaid at list time from the saved-folders
  // record exactly as `name` already is from `nickname` (saved-folder-projects.ts:53).
  // A SYNCED project's description arrives instead on the syncSpaces status
  // payload, mirroring how `displayName` is overlaid there — the hero prefers
  // the synced one.
  description?: string | null;
}

export interface CentralIndex {
  $schema: typeof INDEX_SCHEMA_VERSION;
  projects: CentralIndexProject[];
}
