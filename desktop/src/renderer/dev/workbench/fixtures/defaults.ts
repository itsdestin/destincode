// Shape is fixed by the typed contract: useIpc.ts:216 declares
// `defaults.get(): Promise<{ skipPermissions: boolean; model: string; projectFolder: string }>`.
// Not a loose Record — the compiler checks this one.
export interface MockDefaults {
  skipPermissions: boolean;
  model: string;
  projectFolder: string;
}

export function defaults(): MockDefaults {
  return {
    skipPermissions: false,
    model: 'claude-sonnet-4-6',
    projectFolder: '/home/destin/youcoded-dev/youcoded',
  };
}
