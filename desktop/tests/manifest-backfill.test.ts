// §E3 — the backfill that gives a model downloaded BEFORE this feature a record
// of where it came from. Nothing here is invented: the filenames are the six
// models actually sitting in this machine's ~/.cache/llama.cpp, the curated rows
// are the real shipped list, and the byte counts in the size tests were measured
// against the live Hugging Face API on 2026-09-05.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { updateEngineConfig } from '../src/main/engine/engine-config';
import { ManifestBackfill, curatedRepoStem } from '../src/main/models/manifest-backfill';
import type { BackfillCandidate, BackfillLookups } from '../src/main/models/manifest-backfill';
import { SHIPPED_CURATED } from '../src/main/models/curated-models';
import { parseGgufName } from '../src/main/models/quant-parser';
import { readManifest } from '../src/main/models/download-manifest';
import type { CuratedModel, QuantOption } from '../src/shared/model-manager-types';

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  dir = path.join(root, 'cache');
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const MMPROJ = { path: 'mmproj-F16.gguf', size: 900, sha256: null };

function option(o: {
  quant: string; files: string[]; totalSizeBytes: number; visionFile?: typeof MMPROJ;
}): QuantOption {
  return {
    description: '', sha256ByFile: Object.fromEntries(o.files.map((f) => [f, null])), ...o,
  };
}

/** Plant a published .gguf of an exact size and return the candidate row the
 *  cache scan would produce for it. */
function plant(fileName: string, bytes: number, parts = 1): BackfillCandidate {
  fs.writeFileSync(path.join(dir, fileName), Buffer.alloc(bytes));
  return { dir, firstFileName: fileName, parts, bytesPublished: bytes };
}

interface Spec {
  curated?: CuratedModel[];
  /** Repos the one search returns, most-downloaded first. */
  hits?: string[];
  trees?: Record<string, QuantOption[]>;
  /** The search fails the way an offline machine or a rate limit fails it. */
  searchFails?: boolean;
  /** Listing THESE repos fails — a lookup that could not finish, mid-pass. */
  treeFails?: string[];
  /** Every lookup blocks on this before answering. */
  gate?: Promise<unknown>;
}

/** Answers to the three questions the backfill asks, with a full call record.
 *  `maxConcurrent` is what proves the pass is sequential: each answer marks
 *  itself in flight, yields, and only then unmarks, so two overlapping lookups
 *  are visible even though neither blocks. */
function fakeLookups(spec: Spec) {
  const calls = { curated: 0, search: [] as string[], trees: [] as string[], maxConcurrent: 0 };
  let live = 0;
  const answer = async <T>(produce: () => T): Promise<T> => {
    live += 1;
    calls.maxConcurrent = Math.max(calls.maxConcurrent, live);
    try {
      await (spec.gate ?? Promise.resolve());
      return produce();
    } finally {
      live -= 1;
    }
  };
  const look: BackfillLookups = {
    curated: async () => { calls.curated += 1; return answer(() => spec.curated ?? []); },
    search: async (q) => {
      calls.search.push(q);
      return answer(() => {
        if (spec.searchFails) throw new Error('Hugging Face search is not reachable right now — try again in a moment.');
        return (spec.hits ?? []).map((repo, i) => ({ repo, downloads: 1000 - i, likes: 0 }));
      });
    },
    quantOptions: async (repo) => {
      calls.trees.push(repo);
      return answer(() => {
        if (spec.treeFails?.includes(repo)) throw new Error("Could not list this model's files on Hugging Face — try again in a moment.");
        return spec.trees?.[repo] ?? [];
      });
    },
    now: () => 1_700_000_000_000,
  };
  return { look, calls };
}

async function runPass(look: BackfillLookups, candidates: BackfillCandidate[]): Promise<void> {
  const backfill = new ManifestBackfill(look);
  backfill.kick(candidates);
  await backfill.whenIdle();
}

describe('manifest backfill — resolving the repo', () => {
  it('reads a curated repo down to the stem its own files carry', () => {
    expect(curatedRepoStem('unsloth/gemma-4-12b-it-GGUF')).toBe('gemma-4-12b-it');
    expect(curatedRepoStem('unsloth/Qwen3.5-122B-A10B-GGUF')).toBe('Qwen3.5-122B-A10B');
    // Against the REAL shipped list, the two facts the curated match is built
    // on: no stem may keep the '-GGUF' suffix (a stem that did would never
    // equal a filename's), and every stem must be exactly what parseGgufName
    // reads back out of that repo's own default-quant filename.
    for (const m of SHIPPED_CURATED) {
      const stem = curatedRepoStem(m.hfRepo);
      expect(stem, m.hfRepo).not.toMatch(/-GGUF$/i);
      expect(parseGgufName(`${stem}-${m.quantDefault}.gguf`)?.base, m.hfRepo).toBe(stem);
      expect(parseGgufName(`${stem}-${m.quantDefault}.gguf`)?.quant, m.hfRepo).toBe(m.quantDefault);
    }
  });

  it('a curated model resolves from the shipped list without a single search', async () => {
    // A real row of the shipped list — 'gemma4-12b' — at the exact filename its
    // repo publishes that default quant under.
    const c = plant('gemma-4-12b-it-UD-Q4_K_XL.gguf', 120);
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      // Any search at all is a failure here, loudly: nothing should reach this.
      searchFails: true,
      trees: {
        'unsloth/gemma-4-12b-it-GGUF': [
          option({ quant: 'UD-Q4_K_XL', files: ['gemma-4-12b-it-UD-Q4_K_XL.gguf'], totalSizeBytes: 120, visionFile: MMPROJ }),
        ],
      },
    });
    await runPass(look, [c]);

    expect(calls.search).toEqual([]);
    expect(calls.trees).toEqual(['unsloth/gemma-4-12b-it-GGUF']);
    const got = readManifest(dir, c.firstFileName);
    expect(got?.repo).toBe('unsloth/gemma-4-12b-it-GGUF');
    expect(got?.quant).toBe('UD-Q4_K_XL');
    expect(got?.visionFile).toEqual(MMPROJ);
    // completedAt is the weights' own mtime — when the download really landed —
    // not the clock at backfill time.
    expect(got?.completedAt).toBe(Math.round(fs.statSync(path.join(dir, c.firstFileName)).mtimeMs));
    expect(got?.completedAt).not.toBe(1_700_000_000_000);
  });

  it('a model the curated list does not name falls through to exactly ONE search', async () => {
    // Really on this machine. The shipped list DOES carry Qwen3.5 2B — but at
    // UD-Q4_K_XL, and this copy is Q8_0, so the curated match does not fire.
    const c = plant('Qwen3.5-2B-Q8_0.gguf', 240);
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['bartowski/Qwen3.5-2B-GGUF', 'unsloth/Qwen3.5-2B-GGUF'],
      trees: {
        // Same filename, DIFFERENT bytes — another publisher's build, refused.
        'bartowski/Qwen3.5-2B-GGUF': [
          option({ quant: 'Q8_0', files: ['Qwen3.5-2B-Q8_0.gguf'], totalSizeBytes: 999 }),
        ],
        'unsloth/Qwen3.5-2B-GGUF': [
          option({ quant: 'Q8_0', files: ['Qwen3.5-2B-Q8_0.gguf'], totalSizeBytes: 240, visionFile: MMPROJ }),
        ],
      },
    });
    await runPass(look, [c]);

    expect(calls.search).toEqual(['Qwen3.5-2B']);
    expect(readManifest(dir, c.firstFileName)?.repo).toBe('unsloth/Qwen3.5-2B-GGUF');
  });

  it('a repo that calls the file something else is refused, however right the rest looks', async () => {
    const c = plant('Qwen3.5-9B-Q8_0.gguf', 500);
    const { look } = fakeLookups({
      hits: ['someone/Qwen3.5-9B-GGUF'],
      trees: {
        // Right quant, right size — but the repo calls the file something else.
        'someone/Qwen3.5-9B-GGUF': [
          option({ quant: 'Q8_0', files: ['Qwen3.5-9B-instruct-Q8_0.gguf'], totalSizeBytes: 500 }),
        ],
      },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBeNull();
  });

  it('two publishers with the same file at the same size resolve to NO repo', async () => {
    const c = plant('Qwen3.6-27B-Q8_0.gguf', 700);
    const files = ['Qwen3.6-27B-Q8_0.gguf'];
    const { look, calls } = fakeLookups({
      hits: ['a/Qwen3.6-27B-GGUF', 'b/Qwen3.6-27B-GGUF'],
      trees: {
        'a/Qwen3.6-27B-GGUF': [option({ quant: 'Q8_0', files, totalSizeBytes: 700, visionFile: MMPROJ })],
        'b/Qwen3.6-27B-GGUF': [option({ quant: 'Q8_0', files, totalSizeBytes: 700 })],
      },
    });
    await runPass(look, [c]);

    // Both were looked at, and neither was written: picking the more popular
    // one would be a guess, and a wrong publisher mispairs the vision file.
    expect(calls.trees).toEqual(['a/Qwen3.6-27B-GGUF', 'b/Qwen3.6-27B-GGUF']);
    const got = readManifest(dir, c.firstFileName);
    expect(got?.repo).toBeNull();
    expect(got?.visionFile).toBeUndefined();
  });

  // Real bytes, measured on 2026-09-05 against this machine's own cache and the
  // live Hugging Face API. TWO accounts publish 'gemma-4-E2B-it-Q8_0.gguf':
  // unsloth's is the same build re-uploaded (2,016 bytes bigger, a metadata
  // edit), lmstudio-community's is that account's own quantization (80.9 MB
  // smaller). Demanding an exact byte count refused BOTH — including the right
  // one — which is why SIZE_TOLERANCE exists.
  const ON_DISK = 5_048_350_848;
  const UNSLOTH_REUPLOAD = 5_048_352_864;
  const LMSTUDIO_OWN_QUANT = 4_967_497_152;

  it('accepts the publisher who re-uploaded the same build, and refuses the one who made their own', async () => {
    const c = plant('gemma-4-E2B-it-Q8_0.gguf', 1);
    c.bytesPublished = ON_DISK;   // the real file is 5 GB; only its size matters here
    const files = ['gemma-4-E2B-it-Q8_0.gguf'];
    const { look } = fakeLookups({
      hits: ['unsloth/gemma-4-E2B-it-GGUF', 'lmstudio-community/gemma-4-E2B-it-GGUF'],
      trees: {
        'unsloth/gemma-4-E2B-it-GGUF': [option({ quant: 'Q8_0', files, totalSizeBytes: UNSLOTH_REUPLOAD, visionFile: MMPROJ })],
        'lmstudio-community/gemma-4-E2B-it-GGUF': [option({ quant: 'Q8_0', files, totalSizeBytes: LMSTUDIO_OWN_QUANT })],
      },
    });
    await runPass(look, [c]);

    // Exactly one survivor, so there is nothing to choose between: the other
    // account is ruled OUT by its size, not out-ranked by popularity.
    const got = readManifest(dir, c.firstFileName);
    expect(got?.repo).toBe('unsloth/gemma-4-E2B-it-GGUF');
    expect(got?.visionFile).toEqual(MMPROJ);
  });

  it('refuses a lone repo whose copy is a different build, rather than settle for it', async () => {
    const c = plant('gemma-4-E2B-it-Q8_0.gguf', 1);
    c.bytesPublished = ON_DISK;
    const { look } = fakeLookups({
      hits: ['lmstudio-community/gemma-4-E2B-it-GGUF'],
      trees: {
        'lmstudio-community/gemma-4-E2B-it-GGUF': [option({
          quant: 'Q8_0', files: ['gemma-4-E2B-it-Q8_0.gguf'], totalSizeBytes: LMSTUDIO_OWN_QUANT, visionFile: MMPROJ,
        })],
      },
    });
    await runPass(look, [c]);
    // The only repo that publishes the name — and still refused, because these
    // are not the bytes on disk. Being the only candidate is not evidence.
    expect(readManifest(dir, c.firstFileName)?.repo).toBeNull();
  });

  it('an EXACT byte match outranks a near one, and is not a popularity contest', async () => {
    // Real bytes, measured the same day. This machine's Qwen3.5-2B-Q8_0.gguf is
    // 2,012,012,800 bytes; unsloth publishes exactly that, lmstudio-community
    // publishes the same filename 800 bytes smaller. BOTH are inside
    // SIZE_TOLERANCE, so only the exact match can settle it — and it is listed
    // SECOND here, so a rule that just took the first hit would get it wrong.
    const c = plant('Qwen3.5-2B-Q8_0.gguf', 1);
    c.bytesPublished = 2_012_012_800;
    const files = ['Qwen3.5-2B-Q8_0.gguf'];
    const { look, calls } = fakeLookups({
      hits: ['lmstudio-community/Qwen3.5-2B-GGUF', 'unsloth/Qwen3.5-2B-GGUF'],
      trees: {
        'lmstudio-community/Qwen3.5-2B-GGUF': [option({ quant: 'Q8_0', files, totalSizeBytes: 2_012_012_000 })],
        'unsloth/Qwen3.5-2B-GGUF': [option({ quant: 'Q8_0', files, totalSizeBytes: 2_012_012_800, visionFile: MMPROJ })],
      },
    });
    await runPass(look, [c]);

    // Both were read before anything was decided — no early exit at the first
    // two survivors, or the exact match below them is never seen.
    expect(calls.trees).toEqual(['lmstudio-community/Qwen3.5-2B-GGUF', 'unsloth/Qwen3.5-2B-GGUF']);
    expect(readManifest(dir, c.firstFileName)?.repo).toBe('unsloth/Qwen3.5-2B-GGUF');
  });

  it('a repo offering this quant as a different NUMBER of parts is refused', async () => {
    const c = plant('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', 400, 4);
    const { look } = fakeLookups({
      hits: ['x/Qwen3.8-Flash-Next-GGUF'],
      trees: {
        // Deliberately identical on the other two equalities — the same first
        // filename, the same total size — so ONLY the part count can refuse it.
        'x/Qwen3.8-Flash-Next-GGUF': [option({
          quant: 'UD-Q4_K_XL',
          files: [
            'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf',
            'Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004.gguf',
            'Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004.gguf',
          ],
          totalSizeBytes: 400,
        })],
      },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBeNull();
  });

  it('a split set is matched whole, and a miss still records every part', async () => {
    // Really on this machine: four parts, addressed through part 1.
    const c = plant('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', 400, 4);
    const { look, calls } = fakeLookups({
      hits: ['x/Qwen3.8-Flash-Next-GGUF'],
      trees: {
        // The same quant, the same size, but only THREE parts — not this set.
        'x/Qwen3.8-Flash-Next-GGUF': [option({
          quant: 'UD-Q4_K_XL',
          files: [
            'UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00003.gguf',
            'UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00003.gguf',
            'UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00003.gguf',
          ],
          totalSizeBytes: 400,
        })],
      },
    });
    await runPass(look, [c]);

    expect(calls.search).toEqual(['Qwen3.8-Flash-Next']);
    expect(readManifest(dir, c.firstFileName)).toMatchObject({
      repo: null,
      quant: 'UD-Q4_K_XL',
      totalSizeBytes: 400,
      files: [
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf',
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004.gguf',
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004.gguf',
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004.gguf',
      ],
    });
  });
});

describe('manifest backfill — what is permanent and what is retried', () => {
  it('a search that FAILS writes nothing at all, and the next app run tries again', async () => {
    // Destin's own pre-feature download, and the case §E3 exists for.
    const c = plant('gemma-4-E2B-it-Q8_0.gguf', 80);

    const offline = fakeLookups({ curated: SHIPPED_CURATED, searchFails: true });
    await runPass(offline.look, [c]);
    expect(offline.calls.search).toEqual(['gemma-4-E2B-it']);
    // NOT a miss: a manifest here would be the permanent "we looked and could
    // not find it" record, written on the strength of a network failure.
    expect(fs.existsSync(path.join(dir, 'gemma-4-E2B-it-Q8_0.gguf.download.json'))).toBe(false);
    expect(readManifest(dir, c.firstFileName)).toBeNull();

    // A new app run — a new ManifestBackfill — with Hugging Face reachable.
    const online = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['unsloth/gemma-4-E2B-it-GGUF'],
      trees: {
        'unsloth/gemma-4-E2B-it-GGUF': [
          option({ quant: 'Q8_0', files: ['gemma-4-E2B-it-Q8_0.gguf'], totalSizeBytes: 80, visionFile: MMPROJ }),
        ],
      },
    });
    await runPass(online.look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBe('unsloth/gemma-4-E2B-it-GGUF');
    expect(readManifest(dir, c.firstFileName)?.visionFile).toEqual(MMPROJ);
  });

  it('a repo listing that fails mid-pass abandons that model rather than calling it a miss', async () => {
    const c = plant('gpt-oss-20b-MXFP4.gguf', 300);
    const { look } = fakeLookups({
      hits: ['unsloth/gpt-oss-20b-GGUF', 'other/gpt-oss-20b-GGUF'],
      treeFails: ['other/gpt-oss-20b-GGUF'],
      trees: {
        'unsloth/gpt-oss-20b-GGUF': [
          option({ quant: 'MXFP4', files: ['gpt-oss-20b-MXFP4.gguf'], totalSizeBytes: 300 }),
        ],
      },
    });
    await runPass(look, [c]);
    // One repo DID confirm — but the second could not be checked, so it cannot
    // be ruled out as a rival. Writing either answer would be a guess.
    expect(readManifest(dir, c.firstFileName)).toBeNull();
  });

  it('a failed lookup is not retried for the rest of the app run', async () => {
    const c = plant('Qwen3.5-2B-Q8_0.gguf', 240);
    const { look, calls } = fakeLookups({ searchFails: true });
    const backfill = new ManifestBackfill(look);
    backfill.kick([c]);
    await backfill.whenIdle();
    // The Local Models screen re-opening must not re-run a lookup that just
    // failed — that would hammer Hugging Face once per render.
    backfill.kick([c]);
    await backfill.whenIdle();
    expect(calls.search).toEqual(['Qwen3.5-2B']);
  });
});

describe('manifest backfill — one at a time, and never on the render path', () => {
  it('backfills models sequentially, never two lookups at once', async () => {
    const cs = [
      plant('Qwen3.5-2B-Q8_0.gguf', 10),
      plant('Qwen3.5-9B-Q8_0.gguf', 20),
      plant('Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', 30),
    ];
    const { look, calls } = fakeLookups({ hits: [] });
    await runPass(look, cs);

    expect(calls.maxConcurrent).toBe(1);
    // …and all three really were done, so "one at a time" isn't just "one ran".
    expect(calls.search).toEqual(['Qwen3.5-2B', 'Qwen3.5-9B', 'Qwen3.6-35B-A3B']);
  });

  it('a second kick while a pass is running is ignored, so no model is looked up twice', async () => {
    const cs = [
      plant('Qwen3.5-2B-Q8_0.gguf', 10),
      plant('Qwen3.5-9B-Q8_0.gguf', 20),
    ];
    let release = () => { /* replaced below */ };
    const gate = new Promise<void>((r) => { release = r; });
    const { look, calls } = fakeLookups({ hits: [], gate });
    const backfill = new ManifestBackfill(look);
    backfill.kick(cs);
    backfill.kick(cs);          // the screen re-rendered while the first pass is mid-flight
    release();
    await backfill.whenIdle();
    expect(calls.search).toEqual(['Qwen3.5-2B', 'Qwen3.5-9B']);
  });
});

describe('manifest backfill — through installedModels()', () => {
  let userData: string;
  let cacheDir: string;
  let home: NativeHome;

  beforeEach(async () => {
    userData = path.join(root, 'userData');
    cacheDir = path.join(root, 'llama-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    home = new NativeHome(path.join(root, 'home'));
    await updateEngineConfig(home, { cacheDir });
  });

  it('installedModels() answers before the backfill has asked anything', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Qwen3.5-2B-Q8_0.gguf'), Buffer.alloc(240));
    let release = () => { /* replaced below */ };
    const gate = new Promise<void>((r) => { release = r; });
    const { look, calls } = fakeLookups({ gate, searchFails: true });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    const rows = await mgr.installedModels();
    expect(rows).toHaveLength(1);
    // Nothing has even been ASKED yet. kick() defers the whole pass to a later
    // tick, so a slow Hugging Face can never hold up the model list. (If the
    // list waited on the pass instead, this await would hang on the gate.)
    expect(calls.curated).toBe(0);

    release();
    await mgr.backfillIdle();
  });

  it('gives a pre-feature download its repo and its eye — and never looks twice', async () => {
    // Destin's own model, byte-for-byte the case §E3 was written for.
    fs.writeFileSync(path.join(cacheDir, 'gemma-4-E2B-it-Q8_0.gguf'), Buffer.alloc(80));
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['unsloth/gemma-4-E2B-it-GGUF'],
      trees: {
        'unsloth/gemma-4-E2B-it-GGUF': [
          option({ quant: 'Q8_0', files: ['gemma-4-E2B-it-Q8_0.gguf'], totalSizeBytes: 80, visionFile: MMPROJ }),
        ],
      },
    });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    // Before: a complete model that nothing knows anything about.
    expect(await mgr.installedModels()).toEqual([expect.objectContaining({
      id: 'gemma-4-E2B-it-Q8_0', status: 'complete', repo: null, vision: 'none', visionBytes: null,
    })]);
    await mgr.backfillIdle();

    // After: its publisher is known, and the row offers "Add vision".
    expect(await mgr.installedModels()).toEqual([expect.objectContaining({
      id: 'gemma-4-E2B-it-Q8_0', status: 'complete',
      repo: 'unsloth/gemma-4-E2B-it-GGUF', vision: 'available', visionBytes: 900,
    })]);
    await mgr.backfillIdle();
    // The record on disk is the answer now — the second open looked nothing up.
    expect(calls.search).toEqual(['gemma-4-E2B-it']);
    expect(calls.trees).toEqual(['unsloth/gemma-4-E2B-it-GGUF']);
  });

  it('a model nobody publishes is recorded as untraceable, and is never searched again', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf'), Buffer.alloc(50));
    const { look, calls } = fakeLookups({ hits: [] });   // the search succeeds, and finds nothing
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    await mgr.installedModels();
    await mgr.backfillIdle();
    expect(calls.search).toEqual(['Mystery']);
    expect(readManifest(cacheDir, 'Mystery-Q4_K_M.gguf')).toMatchObject({
      repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'], totalSizeBytes: 50,
    });

    // Re-opening the screen — and, because the record is on disk rather than in
    // memory, every future app run too — costs no lookup at all.
    expect(await mgr.installedModels()).toEqual([expect.objectContaining({
      id: 'Mystery-Q4_K_M', status: 'complete', repo: null, vision: 'none',
    })]);
    await mgr.backfillIdle();
    expect(calls.search).toEqual(['Mystery']);
  });

  it('leaves a model that already has a manifest alone', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Done-GGUF', quant: 'Q4_K_M', files: ['Done-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    const { look, calls } = fakeLookups({ curated: SHIPPED_CURATED, searchFails: true });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    await mgr.installedModels();
    await mgr.backfillIdle();
    expect(calls.curated).toBe(0);
    expect(calls.search).toEqual([]);
    expect(readManifest(cacheDir, 'Done-Q4_K_M.gguf')?.completedAt).toBe(2);
  });

  it('leaves an UNFINISHED download alone — it has bytes still coming, not a lost history', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00004.gguf'), Buffer.alloc(10));
    const { look, calls } = fakeLookups({ curated: SHIPPED_CURATED, searchFails: true });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    const rows = await mgr.installedModels();
    expect(rows[0]).toMatchObject({ status: 'untraceable', partsPresent: 1, parts: 4 });
    await mgr.backfillIdle();
    // A set that is short of parts has no size to match a repo against, so
    // there is nothing here that could be resolved honestly.
    expect(calls.curated).toBe(0);
  });
});
