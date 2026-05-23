// IPC channel constants for artifact viewer subsystem
export const ARTIFACT_IPC = {
  LIST_SESSION: 'artifacts:list-session',
  LIST_PROJECT: 'artifacts:list-project',
  GET: 'artifacts:get',
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
} as const;

export type ArtifactIpcChannel = typeof ARTIFACT_IPC[keyof typeof ARTIFACT_IPC];
