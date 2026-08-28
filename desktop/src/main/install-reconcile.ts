// Install reconcile — tell the Worker every plugin this machine actually has.
//
// WHY this exists: `installs` only ever learned about installs made WHILE
// SIGNED IN (marketplace-context.tsx gates the report on `signedIn`). Three
// gaps followed, all of them live:
//
//   1. Plugins bundled with YouCoded (wecoded-themes-plugin, …) are
//      auto-installed at launch by skill-provider.installMany(), which never
//      touches the marketplace client — so they were NEVER reported. Every user
//      has them and none could vote on them.
//   2. Anything installed before signing in had no row.
//   3. Anything installed on another device had no row.
//
// The visible symptom was a plugin whose page shows an Uninstall button being
// refused a vote with "must install plugin before voting" — the app and the
// server disagreeing about what you have.
//
// This runs in MAIN on purpose: the sign-in token already lives here and the
// installed set is a filesystem read here, so it needs no new IPC channel on
// any of the four surfaces.
import path from 'path';
import { listInstalledPluginDirs } from './claude-code-registry';
import type { MarketplaceAuthStore } from './marketplace-auth-store';
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from '../renderer/state/marketplace-api-client';

/** Just enough of LocalSkillProvider to enumerate what is installed — passing the
 *  provider itself would drag its whole dependency tree into this module. */
export interface InstalledSkillSource {
  getInstalled(): Promise<Array<{ id: string }>>;
}

/** Server cap (MAX_INSTALL_BATCH). Slicing here keeps an unusually large
 *  profile from failing the whole reconcile with a 400. */
const MAX_BATCH = 200;

/** Every plugin id present on disk — the directory name IS the id. Includes
 *  bundled plugins, which is the point. */
export function installedPluginIds(): string[] {
  const ids = listInstalledPluginDirs().map((dir) => path.basename(dir));
  // Both roots are scanned, so the same id can appear twice (see
  // listInstalledPluginDirs' note about the pre-decomposition clone).
  return [...new Set(ids)].filter((id) => id.length > 0 && id.length <= 128);
}

/**
 * Every id the marketplace UI can put a Feedback section on — which is the id
 * space votes are cast in, and therefore exactly what has to exist in `installs`.
 *
 * TWO LEVELS, and missing the second is a real bug that shipped once already:
 * a plugin directory is one id (`superpowers`), but the provider ALSO surfaces
 * each scanned skill as its own marketplace item with its own detail page
 * (`superpowers:brainstorming`, 22 of them on one test profile). Reporting only
 * directories left every skill-level page voting on an id with no install row,
 * so the gate refused a vote on a skill the user plainly has — the exact
 * "install it first" the reconcile was written to cure, one level down.
 */
export async function installedMarketplaceIds(skills: InstalledSkillSource | null): Promise<string[]> {
  const ids = installedPluginIds();
  try {
    for (const s of await (skills?.getInstalled() ?? Promise.resolve([]))) {
      if (typeof s?.id === 'string' && s.id.length > 0 && s.id.length <= 128) ids.push(s.id);
    }
  } catch {
    // A provider failure must not lose the directory ids we already have.
  }
  return [...new Set(ids)];
}

/**
 * Report the full installed set. Fire-and-forget by contract: a failure here
 * must never block sign-in or surface an error — the only cost of missing it is
 * that voting stays gated until the next attempt.
 */
export async function reconcileInstalls(
  store: MarketplaceAuthStore,
  skills: InstalledSkillSource | null = null,
): Promise<void> {
  try {
    if (!store.getToken()) return;
    const ids = await installedMarketplaceIds(skills);
    if (ids.length === 0) return;
    const client = createMarketplaceApiClient({
      host: MARKETPLACE_API_HOST,
      getToken: () => store.getToken(),
    });
    await client.postInstalls(ids.slice(0, MAX_BATCH));
  } catch (err) {
    // Deliberately silent: this is background bookkeeping the user never asked
    // for. Logged, not surfaced — an error toast here would be noise on every
    // offline launch.
    console.warn('[install-reconcile] could not report installs (non-fatal):', err);
  }
}
