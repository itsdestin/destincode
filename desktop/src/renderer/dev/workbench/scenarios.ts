import type { SessionInfo } from '../../../shared/types';
import type { TagRecord } from '../../../shared/tags';
import type { FlagName } from '../../components/resume-browser-filters';
import { sessions } from './fixtures/sessions';
import { providers as seedProviders, catalog as seedCatalog, type ProviderRow, type CatalogRow } from './fixtures/providers';
import { tags as seedTags } from './fixtures/tags';
import { defaults as seedDefaults, type MockDefaults } from './fixtures/defaults';

export type ScenarioId = 'default' | 'empty' | 'no-providers' | 'refused' | 'stress';

export const SCENARIO_IDS: readonly ScenarioId[] = [
  'default', 'empty', 'no-providers', 'refused', 'stress',
];

/** A row in the Resume Browser's list. Mirrors ResumeBrowser.tsx:160's local
 *  `PastSession` — that interface is not exported, so this is a hand-kept copy.
 *  Fields omitted here (device, lastUsedModel) are optional and unused by the
 *  surfaces under design; add them when a design needs them rather than
 *  speculatively. */
export interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  flags?: Partial<Record<FlagName, boolean>>;
  tags?: string[];
  note?: string;
  provider?: string;
  harnessId?: string;
  /** Project folder is not on this device — Resume is disabled. */
  missingProject?: boolean;
  /** Folder is here but the transcript hasn't synced yet — also disabled. */
  notSyncedYet?: boolean;
}

export interface MockState {
  sessions: SessionInfo[];
  past: PastSession[];
  providers: ProviderRow[];
  catalog: CatalogRow[];
  tags: TagRecord[];
  defaults: MockDefaults;
}

const PROJECTS = [
  ['/home/destin/youcoded-dev/youcoded', 'youcoded'],
  ['/home/destin/youcoded-dev/wecoded-themes', 'wecoded-themes'],
  ['/home/destin/youcoded-dev/wecoded-marketplace', 'wecoded-marketplace'],
] as const;

// Fixed base timestamp, not Date.now(): a seed that moves with the clock makes
// "2 minutes ago" vs "3 days ago" groupings non-reproducible between reviews.
const T0 = 1_753_800_000_000;

function past(i: number, name: string, extra: Partial<PastSession> = {}): PastSession {
  const [path, slug] = PROJECTS[i % PROJECTS.length];
  return {
    sessionId: `wb-past-${i}`,
    name,
    projectSlug: slug,
    projectPath: path,
    lastModified: T0 - i * 3_600_000,
    size: 4096 + i * 137,
    ...extra,
  };
}

function defaultPast(): PastSession[] {
  return [
    past(0, 'fix chat scroll stick', { flags: { priority: true }, tags: ['tag_bug'] }),
    past(1, 'theme contrast pass', { provider: 'native', harnessId: 'coder' }),
    past(2, 'sync health primary system', { note: 'blocked on the gh dead-end' }),
    past(3, 'menu internals tranche 3', { flags: { complete: true }, tags: ['tag_work'] }),
    past(4, 'ask-about-this reference UX', { tags: ['tag_idea', 'tag_work'] }),
  ];
}

// 220 rows with 80+ char names, holes in the optional fields, and the two
// resume-disabled states. This is the scenario that catches designs which only
// work on tidy data (spec §4) — including the ones that assume every row can
// be resumed.
function stressPast(): PastSession[] {
  return Array.from({ length: 220 }, (_, i) => {
    const extra: Partial<PastSession> = {};
    if (i % 5 === 0) extra.tags = ['tag_work', 'tag_bug', 'tag_idea'];
    if (i % 11 === 0) extra.missingProject = true;
    if (i % 13 === 0) extra.notSyncedYet = true;
    if (i % 7 === 0) extra.note = 'a note long enough to wrap past the row it belongs to, which is the point';
    if (i % 4 === 0) extra.provider = 'native';
    return past(
      i,
      i % 3 === 0
        ? `refactor the transcript watcher byte-offset reader and its eight downstream consumers (${i})`
        : `session ${i}`,
      extra,
    );
  });
}

/** Builds a fresh state for a scenario. Every call re-runs the fixture
 *  factories, so two stores never share a mutable array. */
export function seed(scenario: ScenarioId): MockState {
  const base: MockState = {
    sessions: sessions(),
    past: defaultPast(),
    providers: seedProviders(),
    catalog: seedCatalog(),
    tags: seedTags(),
    defaults: seedDefaults(),
  };
  switch (scenario) {
    case 'empty':
      return { ...base, sessions: [], past: [], tags: [] };
    case 'no-providers':
      // Native runtime is still "supported" — it is the providers that are
      // absent, which is the state the empty-provider guidance renders for.
      return { ...base, providers: base.providers.map((p) => ({ ...p, ready: false })), catalog: [] };
    case 'stress':
      return { ...base, past: stressPast() };
    case 'refused':
    case 'default':
    default:
      return base;
  }
}
