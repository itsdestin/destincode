// The shareable harness unit (marketplace item kind 'harness' arrives in
// Phase 3). Phase 2 ships TWO built-in presets — personality profiles, not
// capability tiers (spec decision 8): both carry the full ten-tool suite;
// they differ in prompt personality and permission posture. The Chat preset
// is CUT — legacy harnessId:'chat' headers resolve to Assistant on resume
// (preset-registry.ts). tools[] stays in the schema for Phase 3 custom harnesses.
import type { ModelBinding } from './provider-types';

export interface HarnessManifest {
  schema: 1;
  id: string; name: string; description?: string;
  systemPrompt: string;                  // fallback one-liner; the real body is a main-side prompt asset
  tools: string[];                       // CC-compatible names (ADR 009)
  /** A string sets the session's STARTING permission mode (the modeFor seed);
   *  a Record maps to presetRules (Phase 3 custom harnesses — unused in v1). */
  permissionPolicy: 'ask' | 'auto-edit' | 'full-auto' | Record<string, 'allow' | 'ask' | 'deny'>;
  defaultBinding?: ModelBinding;
  skills?: string[]; mcp?: string[];
  limits?: { maxSteps?: number; maxTokens?: number };
}

export const NATIVE_TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion',
] as const;

export const ASSISTANT_PRESET: HarnessManifest = {
  schema: 1,
  id: 'assistant',
  name: 'Assistant',
  description: 'Research, write, and get answers — asks before consequential actions.',
  systemPrompt: 'You are a helpful, careful assistant inside YouCoded.',
  tools: [...NATIVE_TOOL_NAMES],
  permissionPolicy: 'ask',
  limits: { maxSteps: 25 },
};

export const CODER_PRESET: HarnessManifest = {
  schema: 1,
  id: 'coder',
  name: 'Coder',
  description: 'Agentic coding — plans with todos, edits confidently, runs and verifies.',
  systemPrompt: 'You are a capable coding agent inside YouCoded.',
  tools: [...NATIVE_TOOL_NAMES],
  permissionPolicy: 'auto-edit',
  limits: { maxSteps: 25 },
};

export const PRESETS: HarnessManifest[] = [ASSISTANT_PRESET, CODER_PRESET];
