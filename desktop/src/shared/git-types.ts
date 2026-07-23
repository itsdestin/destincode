// Git surface IPC payload types (spec docs/active/specs/2026-07-22-git-surface.md).
// Shared main <-> renderer; keep JSON-serializable.
import type { StructuredPatchHunk } from './types';

export interface GitFileCounts {
  added: number;
  removed: number;
}

/** Answer to git:file-status — drives the SessionDrawer footer entry. */
export interface GitFileStatusResult {
  ok: boolean;
  error?: string;
  /** false = not a git repo (or git missing) — footer renders exactly as today. */
  isRepo: boolean;
  branch: string | null;
  /** null when the file has no uncommitted changes vs HEAD. */
  counts: GitFileCounts | null;
  /** true when at least one commit touches this file. */
  hasHistory: boolean;
  /** true when this file has staged (index) changes. */
  staged: boolean;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  /** ISO-8601 author date; relative time is rendered client-side. */
  authorDate: string;
}

export interface GitUncommitted {
  hunks: StructuredPatchHunk[];
  counts: GitFileCounts;
  staged: boolean;
  untracked: boolean;
  /** false when HEAD has no copy of this file (untracked, staged-new, or a
   *  repo with no commits yet) — discard then trashes instead of restoring. */
  inHead: boolean;
  binary: boolean;
}

/** Answer to git:file-review — one payload renders the whole review view. */
export interface GitFileReviewResult {
  ok: boolean;
  error?: string;
  isRepo: boolean;
  branch: string | null;
  uncommitted: GitUncommitted | null;
  log: GitLogEntry[];
  hasMore: boolean;
  /** Repo-wide count of files with staged changes — the commit button label. */
  stagedCount: number;
}

export interface GitCommitFileDiffResult {
  ok: boolean;
  error?: string;
  hunks: StructuredPatchHunk[];
  binary: boolean;
}

export interface GitOpResult {
  ok: boolean;
  error?: string;
}

export interface GitChangedEvent {
  repoRoot: string;
}
