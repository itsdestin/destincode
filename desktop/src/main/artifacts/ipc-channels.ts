// IPC channel constants for artifact viewer subsystem
export const ARTIFACT_IPC = {
  LIST_SESSION: 'artifacts:list-session',
  LIST_PROJECT: 'artifacts:list-project',
  GET: 'artifacts:get',
  SAVE: 'artifacts:save',
  INCLUDE_EXTERNAL: 'artifacts:include-external',
  EXCLUDE: 'artifacts:exclude',
  CHANGED: 'artifacts:changed', // push event
} as const;

export type ArtifactIpcChannel = typeof ARTIFACT_IPC[keyof typeof ARTIFACT_IPC];
