// The shareable harness unit (Phase 0 spec §2; marketplace item kind 'harness'
// arrives in Phase 3). Plan A ships exactly ONE built-in preset (Chat) and no
// preset picker — the picker appears in Phase 2 when the preset family exists.
import type { ModelBinding } from './provider-types';

export interface HarnessManifest {
  schema: 1;
  id: string; name: string; description?: string;
  systemPrompt: string;
  tools: string[];                       // CC-compatible names (ADR 009); empty in Plan A
  permissionPolicy: 'ask' | 'auto-edit' | 'full-auto' | Record<string, 'allow' | 'ask' | 'deny'>;
  defaultBinding?: ModelBinding;
  skills?: string[]; mcp?: string[];     // opt-in subsets; empty = none
  limits?: { maxSteps?: number; maxTokens?: number };
}

export const CHAT_PRESET: HarnessManifest = {
  schema: 1,
  id: 'chat',
  name: 'Chat',
  description: 'Plain conversation — no tools or file access. Tools arrive in a later update.',
  systemPrompt:
    'You are a helpful assistant inside YouCoded, a personal AI app. '
    + 'Answer conversationally and format with Markdown when it helps. '
    + 'You cannot read files, run commands, or browse — if asked, say those abilities are coming in a later update.',
  tools: [],
  permissionPolicy: 'ask',
  limits: { maxTokens: 4096 },
};
