// src/main/conversations/tag-registry-service.ts
// Module singleton for the tag registry (design §"Storage & sync layout").
// Mirrors conversations/service.ts: reads the Personal sync space's managed root
// and owns the createTagRegistry instance. Works with sync OFF — the Tags dir is
// created on first write regardless of the enable flag (same as conversations).
import path from 'node:path';
import { createTagRegistry, TagRegistry } from './tag-registry';
import { getManagedRoots } from '../sync-spaces/service';

let registry: TagRegistry | null = null;

export function getTagRegistry(): TagRegistry | null { return registry; }

export function startTagRegistry(opts?: { tagsRoot?: string }): void {
  stopTagRegistry();
  const personalRoot = getManagedRoots()?.personalRoot;
  const root = opts?.tagsRoot ?? (personalRoot ? path.join(personalRoot, 'Tags') : null);
  if (!root) return; // managed roots unavailable — registry stays off this launch
  registry = createTagRegistry(root);
}

export function stopTagRegistry(): void {
  registry = null;
}
