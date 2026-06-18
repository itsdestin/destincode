// IPC channel constants for artifact viewer subsystem
export const ARTIFACT_IPC = {
  LIST_SESSION: 'artifacts:list-session',
  // CORE PRINCIPLE — two distinct concepts, never merged. (No apostrophes or
  // single quotes in this comment: the parity test treats any single-quoted
  // string here as a channel name.)
  //   LIST_PROJECT   = ARTIFACTS: files Claude directly created/edited (tracked
  //                    sidecar entries, internal or included-external).
  //   LIST_ALL_FILES = ALL FILES: the project folder real documents on disk
  //                    (full-browser view), independent of what Claude touched.
  LIST_PROJECT: 'artifacts:list-project',
  LIST_ALL_FILES: 'artifacts:list-all-files',
  GET: 'artifacts:get',
  // Read a file as base64 bytes — for binary viewers (xlsx/docx/pdf/images) that
  // cannot fetch a file URL from the renderer origin. Takes an absolute path.
  READ_BINARY: 'artifacts:read-binary',
  SAVE: 'artifacts:save',
  // Fix: wire the data-flow gap — renderer calls this when it observes a
  // Write/Edit/MultiEdit tool-use event so the central index and sidecar are
  // populated even when the user never manually opens the artifact drawer.
  APPEND_VERSION: 'artifacts:append-version',
  INCLUDE_EXTERNAL: 'artifacts:include-external',
  EXCLUDE: 'artifacts:exclude',
  CHANGED: 'artifacts:changed', // push event
  LIST_PROJECTS_INDEX: 'artifacts:list-projects-index',
  // Task 7.3: remove a project from the central index (and optionally its sidecar)
  DELETE_PROJECT: 'artifacts:delete-project',
  // Resolves each tracked path and runs fs.access on it in parallel, returning
  // the IDs whose file is missing. Used by SessionDrawer + ProjectView to fold
  // "file not on disk" into the same "deleted" UI state as sidecar-tracked
  // delete versions, so the user only sees one concept.
  // (No apostrophes in this comment — the ipc-channels parity test scans for
  // single-quoted strings and any stray apostrophe would be treated as a channel.)
  CHECK_EXISTENCE: 'artifacts:check-existence',
  // Rename an artifact: renames the file on disk (extension preserved) and
  // updates the sidecar record so version history follows the file. The new
  // name is a basename without extension; collisions are rejected.
  RENAME: 'artifacts:rename',
} as const;

export type ArtifactIpcChannel = typeof ARTIFACT_IPC[keyof typeof ARTIFACT_IPC];
