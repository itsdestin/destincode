import type { SessionInfo } from '../../../../shared/types';

// Two live sessions: one Claude Code, one native. `provider` + `harnessId` are
// what mark a native session (shared/types.ts:67-87) — the transcript carries
// no such marker, so it has to be right here.
//
// Exported as a factory, not a const: every createStore() call needs its own
// array, or one store mutating its session list leaks into the next store built
// in the same page (a reload showing stale data).
//
// MOCKUP: extra native sessions with different providers so the model chip
// restyle (brand colors + icons) is visible across all brands at once.
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
    // --- Mockup: brand-color showcase sessions (native) ---
    {
      id: 'wb-3',
      name: 'gpt-5.6 debug session',
      cwd: '/home/destin/youcoded-dev/wecoded-marketplace',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_785_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'openai/gpt-5.6-sol',
    },
    {
      id: 'wb-4',
      name: 'gemini flash test',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_780_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'google/gemini-2.5-flash',
    },
    {
      id: 'wb-5',
      name: 'claude via openrouter',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_775_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'anthropic/claude-sonnet-4-6',
    },
    {
      id: 'wb-6',
      name: 'grok-3 reasoning test',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_770_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'x-ai/grok-3',
    },
    {
      id: 'wb-7',
      name: 'kimi-k1.5 moonshot session',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_765_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'moonshot/kimi-k1.5',
    },
    {
      id: 'wb-8',
      name: 'deepseek r1 reasoning',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_760_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'deepseek/deepseek-r1',
    },
    {
      id: 'wb-9',
      name: 'llama-3.3 70b local',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_755_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'meta-llama/llama-3.3-70b-instruct',
    },
    {
      id: 'wb-10',
      name: 'codestral fast edit',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_750_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'mistralai/codestral-2501',
    },
    // Specialists 1c: a native conversation that hired helpers — drives the
    // Task-card / status-chip design (fixtures/conversations/specialists.jsonl).
    {
      id: 'wb-11',
      name: 'specialists demo',
      cwd: '/home/destin/youcoded-dev/wecoded-themes',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'active',
      createdAt: 1_753_795_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen3.6-35b-a3b'
    },
  ];
}

// Landing-page embed (scenario=site): ONE native session so the first thing a
// visitor sees is a conversation with a locally running model, not a strip of
// eleven tabs. Field shape mirrors wb-2 above (provider + harnessId mark it native).
export function siteSessions(): SessionInfo[] {
  return [
    {
      id: 'site-1',
      name: 'plan my week',
      cwd: '/home/you/Documents',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_790_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen3-coder-30b-a3b-instruct',
    },
  ];
}
