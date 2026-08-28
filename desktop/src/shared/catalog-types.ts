// Marketplace overhaul (design 2026-08-27, docs/active/investigations/
// 2026-08-27-marketplace-strategy.md §4 Layers A–B): what a catalog row must
// carry for a listing to be judged BEFORE install — what kind of thing it is,
// who published it, what it can do on the machine, and whether it has been
// checked. Everything hangs off `SkillEntry.catalog`, which is optional so
// today's registry (which has none of these fields) keeps loading unchanged.
//
// Two trust signals are kept deliberately separate — "who made it" (origin)
// and "what it does / was it checked" (capabilities + scan) — because merging
// them into one score hides the reason, and the reason is what a non-technical
// user needs to decide (design decision #2, 2026-08-27).

/** The five browsable kinds of installable thing. Themes stay a separate
 *  registry with their own entry type. Commands and hooks are NOT types —
 *  they only exist inside a plugin bundle. */
export type CatalogItemType = 'plugin' | 'skill' | 'specialist' | 'tool' | 'prompt';

export const CATALOG_ITEM_TYPES: readonly CatalogItemType[] = ['plugin', 'skill', 'specialist', 'tool', 'prompt'];

/** User-facing words. "Tool" is the user-facing word for an MCP server
 *  (accessibility rule: no jargon in menus); "Specialist" is the app's
 *  existing word for an agent definition (see Permissions). */
export const CATALOG_TYPE_LABEL: Record<CatalogItemType, { one: string; many: string }> = {
  plugin: { one: 'Plugin', many: 'Plugins' },
  skill: { one: 'Skill', many: 'Skills' },
  specialist: { one: 'Specialist', many: 'Specialists' },
  tool: { one: 'Tool', many: 'Tools' },
  prompt: { one: 'Prompt', many: 'Prompts' },
};

/** Who published it. `youcoded` = shipped by us; `verified` = the publisher
 *  proved they own the name (MCP registry namespace / GitHub org match);
 *  `community` = anyone else. Mirrored-from is a source line, not a tier. */
export type OriginTier = 'youcoded' | 'verified' | 'community';

/** Result of the automated check on THIS version. `unchecked` is the honest
 *  default for freshly mirrored items — shown grey, never red. */
export type ScanStatus = 'checked' | 'caution' | 'unchecked';

/** What the item can do once installed, computed from its files (hooks,
 *  scripts, MCP config, declared secrets) — never self-declared by the author. */
export type CapabilityKind =
  | 'shell'    // runs commands on this computer
  | 'network'  // talks to a named host
  | 'secret'   // needs a token / API key
  | 'files'    // reads or writes files outside its own folder
  | 'auto'     // runs on its own (hooks) rather than when asked
  | 'adds';    // what it adds: "3 commands, 1 hook"

export interface Capability {
  kind: CapabilityKind;
  /** Plain-words line, e.g. "Runs commands on your computer". */
  label: string;
  /** Optional specifics, e.g. "api.github.com" or "GITHUB_TOKEN". */
  detail?: string;
}

/** Kinds worth a glyph on the card itself so they can be spotted while
 *  scrolling; `adds` and `files` only show on the detail page. */
export const RISKY_CAPABILITY_KINDS: readonly CapabilityKind[] = ['shell', 'network', 'secret', 'auto'];

export interface CatalogMeta {
  itemType: CatalogItemType;
  /** Set when this row is a member of a bundle (a skill inside a plugin).
   *  Grouped views hide members; type-filtered views and search show them. */
  partOf?: { id: string; displayName: string };
  origin: { tier: OriginTier; mirroredFrom?: string };
  scan: { status: ScanStatus; checkedAt?: string; findings?: string[] };
  capabilities: Capability[];
  /** SPDX id, e.g. "MIT". Absent = unknown / all rights reserved. */
  license?: string;
  /** The exact upstream commit this listing was taken from (pinned). */
  sourceCommit?: string;
}

/** Type of an entry, defaulting to `plugin` for pre-overhaul registry rows. */
export function catalogType(meta: CatalogMeta | undefined): CatalogItemType {
  return meta?.itemType ?? 'plugin';
}
