import type { SessionInfo } from '../../../../shared/types';

// Two live sessions: one Claude Code, one native. `provider` + `harnessId` are
// what mark a native session (shared/types.ts:67-87) — the transcript carries
// no such marker, so it has to be right here.
//
// Exported as a factory, not a const: every createStore() call needs its own
// array, or one store mutating its session list leaks into the next store built
// in the same page (a reload showing stale data).
export function sessions(): SessionInfo[] {
  return [
    {
      id: 'wb-1',
      name: 'fix chat scroll stick',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'active',
      createdAt: 1_753_800_000_000,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    },
    {
      id: 'wb-2',
      name: 'theme contrast pass',
      cwd: '/home/destin/youcoded-dev/wecoded-themes',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_790_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen2.5-coder:14b',
    },
    // Specialists 1c: a native conversation that hired helpers — drives the
    // Task-card / status-chip design (fixtures/conversations/specialists.jsonl).
    {
      id: 'wb-3',
      name: 'specialists demo',
      cwd: '/home/destin/youcoded-dev/wecoded-themes',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'active',
      createdAt: 1_753_795_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen3.6-35b-a3b',
    },
  ];
}
