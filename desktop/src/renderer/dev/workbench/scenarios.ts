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

/** A row in the Resume Browser's list. Mirrors ResumeBrowser.tsx's local
 *  `PastSession` — that interface is not exported, so this is a hand-kept copy.
 *  Fields omitted here (device) are optional and unused by the surfaces under
 *  design; add them when a design needs them rather than speculatively —
 *  `lastUsedModel` was added on 2026-07-31 when the card started showing it. */
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
  /** Model this conversation last ran a turn on. Native sessions only in the
   *  real app — see the long note on ResumeBrowser's copy of this field. */
  lastUsedModel?: { modelId: string; providerType: string; providerLabel: string };
}

/** Per-session tags/note/flags for LIVE sessions — what session.getMeta reads.
 *  Kept separate from `past` because the two are keyed by different id spaces:
 *  a live session's id is never a row in the resume list. The writers mirror
 *  into `past` as well when a row with the same id happens to exist, so the
 *  Resume Browser and the in-session chip can't disagree about the same
 *  conversation. */
export interface MockSessionMeta {
  tags: string[];
  note: string;
  flags: Record<string, boolean>;
}

export interface MockState {
  sessions: SessionInfo[];
  past: PastSession[];
  meta: Record<string, MockSessionMeta>;
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

// `lastUsedModel` is deliberately present on SOME rows and absent on others.
// That asymmetry is real, not fixture laziness: only native sessions record a
// model ref today (see PastSession.lastUsedModel in ResumeBrowser.tsx for the
// trace), so a design that assumes every card can show a model chip would look
// fine here and wrong in the app. Rows 0 and 3 stay bare on purpose.
function defaultPast(): PastSession[] {
  return [
    past(0, 'fix chat scroll stick', { flags: { priority: true }, tags: ['tag_bug'] }),
    past(1, 'theme contrast pass', {
      provider: 'native',
      harnessId: 'coder',
      lastUsedModel: { modelId: 'gpt-5.6-sol', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    }),
    past(2, 'sync health primary system', {
      note: 'blocked on the gh dead-end',
      provider: 'native',
      lastUsedModel: { modelId: 'qwen3-coder-30b-a3b-instruct', providerType: 'local-engine', providerLabel: 'Local' },
    }),
    past(3, 'menu internals tranche 3', { flags: { complete: true }, tags: ['tag_work'] }),
    past(4, 'ask-about-this reference UX', {
      tags: ['tag_idea', 'tag_work'],
      provider: 'native',
      lastUsedModel: { modelId: 'claude-sonnet-4-6', providerType: 'anthropic', providerLabel: 'Anthropic' },
    }),
  ];
}

// 220 rows with 80+ char names, holes in the optional fields, and the two
// resume-disabled states. This is the scenario that catches designs which only
// work on tidy data (spec §4) — including the ones that assume every row can
// be resumed.
//
// The count is overridable via `?stressRows=N` so a perf harness can drive the
// list to Destin's real scale (~1,642 rows) WITHOUT editing this file. It used
// to require a temporary source edit that had to be remembered and reverted;
// the default stays 220 on purpose, because that is the size at which the
// stress scenario is still usable for design work.
function stressRowCount(): number {
  // The fixture factories are unit-tested under vitest's `node` environment,
  // where there is no `location` — reading it unguarded fails workbench-store.test.ts.
  if (typeof location === 'undefined') return 220;
  const raw = Number(new URLSearchParams(location.search).get('stressRows'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 20000) : 220;
}

function stressPast(): PastSession[] {
  return Array.from({ length: stressRowCount() }, (_, i) => {
    const extra: Partial<PastSession> = {};
    if (i % 5 === 0) extra.tags = ['tag_work', 'tag_bug', 'tag_idea'];
    if (i % 11 === 0) extra.missingProject = true;
    if (i % 13 === 0) extra.notSyncedYet = true;
    if (i % 7 === 0) extra.note = 'a note long enough to wrap past the row it belongs to, which is the point';
    if (i % 4 === 0) extra.provider = 'native';
    // Long model ids are the stress case for the card's bottom line, which now
    // carries project + model + timestamp on one row.
    if (i % 4 === 0) extra.lastUsedModel = i % 8 === 0
      ? { modelId: 'qwen3-coder-30b-a3b-instruct-1m', providerType: 'local-engine', providerLabel: 'Local' }
      : { modelId: 'gpt-5.6-sol', providerType: 'openrouter', providerLabel: 'OpenRouter' };
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
    // The live CC session starts with a tag and Priority set, so the StatusBar
    // chip and the close prompt both have something to render without the
    // reviewer having to click first.
    meta: { 'wb-1': { tags: ['tag_work'], note: '', flags: { priority: true } } },
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
