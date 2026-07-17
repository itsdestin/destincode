// Resolves a stored/requested harnessId to the full runtime preset (manifest +
// main-side prompt body + permission posture). THE ONE place the legacy
// 'chat' → Assistant mapping lives (spec decision 8: Chat preset cut; old
// sessions resume as Assistant). Unknown ids also fall back to Assistant —
// a header written by a NEWER app version must resume, never brick.
import { ASSISTANT_PRESET, CODER_PRESET, type HarnessManifest } from '../../shared/harness-manifest';
import type { NativePermissionMode, PermissionRule } from '../../shared/permission-types';
import { ASSISTANT_DEFAULT_BODY } from './prompts/assistant-default';
import { CODER_DEFAULT_BODY } from './prompts/coder-default';

export interface ResolvedPreset {
  manifest: HarnessManifest;
  body: string;
  defaultMode: NativePermissionMode;
  presetRules: PermissionRule[];
}

const BODIES: Record<string, string> = { assistant: ASSISTANT_DEFAULT_BODY, coder: CODER_DEFAULT_BODY };

export function resolvePreset(harnessId: string | undefined, manifestOverride?: HarnessManifest): ResolvedPreset {
  const manifest = manifestOverride
    ?? (harnessId === 'coder' ? CODER_PRESET : ASSISTANT_PRESET);
  const policy = manifest.permissionPolicy;
  const defaultMode: NativePermissionMode = typeof policy === 'string' ? policy : 'ask';
  const presetRules: PermissionRule[] = typeof policy === 'string'
    ? []
    : Object.entries(policy).map(([tool, action]) => ({ tool, action }));
  return { manifest, body: BODIES[manifest.id] ?? ASSISTANT_DEFAULT_BODY, defaultMode, presetRules };
}
