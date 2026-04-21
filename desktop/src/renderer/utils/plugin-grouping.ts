import type { SkillEntry, InstalledPluginGroup } from '../../shared/types';

// Title-case fallback when we don't have a marketplace-supplied displayName
function titleCase(id: string): string {
  return id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Group installed SkillEntry objects by their pluginName.
 *
 * - Skills with a matching pluginName merge into one group, enriched with
 *   plugin-level metadata (displayName, description, category, prompt) from
 *   the marketplace entry if available.
 * - Skills without a pluginName become single-skill groups (standalone user
 *   skills, or entries whose plugin isn't in the registry).
 * - Output preserves installed-skill ordering by iterating the input once.
 */
export function groupInstalledByPlugin(
  installed: SkillEntry[],
  marketplace: SkillEntry[],
): InstalledPluginGroup[] {
  const registryById = new Map(marketplace.map(e => [e.id, e]));
  const byPluginId = new Map<string, InstalledPluginGroup>();

  for (const skill of installed) {
    const pluginId = skill.pluginName ?? skill.id;
    const existing = byPluginId.get(pluginId);
    if (existing) {
      existing.skills.push(skill);
      continue;
    }
    const registryEntry = registryById.get(pluginId);
    const group: InstalledPluginGroup = {
      id: pluginId,
      displayName: registryEntry?.displayName ?? titleCase(pluginId),
      description: registryEntry?.description ?? skill.description ?? '',
      category: registryEntry?.category ?? skill.category ?? 'other',
      // SkillEntry.prompt is required; fall back through registry → first skill → empty
      prompt: registryEntry?.prompt ?? skill.prompt ?? '',
      source: registryEntry?.source ?? skill.source,
      type: 'plugin',
      visibility: 'published',
      author: registryEntry?.author,
      installedAt: skill.installedAt,
      iconUrl: (registryEntry as any)?.iconUrl,
      accentColor: (registryEntry as any)?.accentColor,
      skills: [skill],
    };
    byPluginId.set(pluginId, group);
  }

  return Array.from(byPluginId.values());
}
