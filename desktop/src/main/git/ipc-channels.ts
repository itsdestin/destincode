// IPC channel constants for the git surface (spec 2026-07-22).
// Comment rule: never put a single-quoted string inside a comment in this
// file family — parity tests harvest every quoted token as a channel name.
export const GIT_IPC = {
  FILE_STATUS: 'git:file-status',
  FILE_REVIEW: 'git:file-review',
  COMMIT_FILE_DIFF: 'git:commit-file-diff',
  STAGE: 'git:stage',
  UNSTAGE: 'git:unstage',
  COMMIT: 'git:commit',
  DISCARD: 'git:discard',
  WATCH: 'git:watch',
  UNWATCH: 'git:unwatch',
  CHANGED: 'git:changed',
} as const;

export type GitIpcChannel = typeof GIT_IPC[keyof typeof GIT_IPC];
