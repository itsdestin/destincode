// IPC channel constants for artifact viewer subsystem
export const ARTIFACT_IPC = {
  LIST_SESSION: 'artifacts:list-session',
  LIST_PROJECT: 'artifacts:list-project',
  GET: 'artifacts:get',
  SAVE: 'artifacts:save',
  INCLUDE_EXTERNAL: 'artifacts:include-external',
  EXCLUDE: 'artifacts:exclude',
  CHANGED: 'artifacts:changed', // push event
  LIST_PROJECTS_INDEX: 'artifacts:list-projects-index',
  // Task 7.3: remove a project from the central index (and optionally its sidecar)
  DELETE_PROJECT: 'artifacts:delete-project',
} as const;

export type ArtifactIpcChannel = typeof ARTIFACT_IPC[keyof typeof ARTIFACT_IPC];
