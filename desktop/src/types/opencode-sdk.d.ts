// Minimal type shim for @opencode-ai/sdk@1.14.35.
//
// The SDK ships its types only under its package.json `exports` map, which
// requires moduleResolution: 'node16' | 'nodenext' | 'bundler' to discover.
// The desktop project uses moduleResolution: 'node' (legacy) so tsc cannot
// find them automatically. Bumping the project's moduleResolution would
// affect every import in the codebase — too risky pre-MVP.
//
// We use very little of the SDK's surface (just the factory and a few
// `client.session.*` / `client.event.*` methods, all accessed via `: any`),
// so a narrow declaration-only shim is sufficient. If we ever want real
// type-checking against the SDK, swap this file for a moduleResolution bump.

declare module '@opencode-ai/sdk' {
  export interface OpencodeClientConfig {
    baseURL?: string;
    [key: string]: any;
  }
  export function createOpencodeClient(config?: OpencodeClientConfig): any;
  export class OpencodeClient {
    constructor(config?: OpencodeClientConfig);
    [key: string]: any;
  }
}
