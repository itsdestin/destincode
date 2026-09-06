// §E3 — giving a model that was downloaded BEFORE this feature its history back.
//
// Every download now leaves a manifest beside it recording which Hugging Face
// repo the files came from and whether that repo ships a vision projector.
// Downloads made before that existed have no manifest at all, so the app has no
// way to know those models can see images — which means they can never show the
// eye, and can never offer "Add vision", permanently. This resolves the repo
// ONCE per model and writes the manifest the download would have written.
//
// Two rules keep it out of the user's way:
//   - It never blocks the model list. installedModels() hands over the
//     candidates and returns; the lookups start on a later tick.
//   - It is strictly SEQUENTIAL — one model, one request in flight. Nobody is
//     waiting for this, and a burst of parallel Hugging Face calls is exactly
//     what earns an IP a rate limit.
//
// Two rules keep it honest:
//   - A WRONG REPO IS IMPOSSIBLE. See SIZE_TOLERANCE and `confirm` below for
//     the whole rule and the measurements behind it. In one line: the repo must
//     publish this exact quant, under this exact filename, in this exact number
//     of parts, at all but the same size — and if two repos survive that with
//     nothing to separate them, no repo is recorded at all (`pickOne`). Several
//     Hugging Face accounts publish the identical GGUF filename (see
//     writeManifest's same-publisher note), and a manifest naming the wrong one
//     would later fetch a projector built for someone else's weights.
//   - A FAILURE IS NOT A MISS. `repo: null` — the permanent "we looked and
//     could not find it" record — is written only when every lookup SUCCEEDED
//     and the answer was genuinely "none of these". A search that is offline,
//     times out, is rate-limited or 5xxs writes NOTHING, and is tried again the
//     next time the app starts.
import * as fs from 'fs';
import * as path from 'path';
import type {
  CuratedModel, DownloadManifest, HFSearchHit, QuantOption,
} from '../../shared/model-manager-types';
import { parseGgufName } from './quant-parser';
import { writeBackfillManifest } from './download-manifest';
import { CuratedCatalog } from './curated-catalog';
import { HfClient } from './hf-client';

/** One complete download on disk that has no manifest — everything the lookup
 *  needs to identify it, read straight off the cache scan. */
export interface BackfillCandidate {
  /** The directory the files and the manifest live in (a model's own folder
   *  when it has one, else the cache dir). */
  dir: string;
  /** The FIRST file's basename including `.gguf` — the manifest's key. */
  firstFileName: string;
  /** Declared part count from the `-of-000NN` suffix; 1 for a single file. */
  parts: number;
  /** Published weight bytes, exactly as the cache scan measured them. */
  bytesPublished: number;
}

/** The questions the backfill asks the outside world, injected so the tests can
 *  answer them without a network — and so nothing that merely constructs an
 *  EngineManager can accidentally reach Hugging Face. */
export interface BackfillLookups {
  curated(): Promise<CuratedModel[]>;
  search(query: string): Promise<HFSearchHit[]>;
  quantOptions(repo: string): Promise<QuantOption[]>;
  now(): number;
}

// How many of a search's hits are checked. Hugging Face returns them sorted by
// downloads, and the account that actually published a given GGUF filename is
// at the top of a search for that model's own name — so the cap costs almost
// nothing in hit rate and bounds the background traffic at five listings per
// model, once ever.
const MAX_SEARCH_CANDIDATES = 5;

// How far a repo's copy of a file may be from the copy on disk and still be
// believed to be the same build. MEASURED on 2026-09-05 against the real
// gemma-4-E2B-it-Q8_0.gguf in this machine's cache (5,048,350,848 bytes), which
// TWO accounts publish under that identical name:
//   unsloth/gemma-4-E2B-it-GGUF          5,048,352,864   +2,016 bytes  0.00004%
//   lmstudio-community/gemma-4-E2B-it-GGUF   4,967,497,152  -80.9 MB       1.6%
// The first is the same build re-uploaded — publishers routinely re-emit a GGUF
// to fix a chat template or a tokenizer field, which moves the file by
// kilobytes. The second is a DIFFERENT account's own quantization of the same
// model at the same quant, and it is off by 80 megabytes.
//
// So demanding an exact byte count would refuse the right publisher over a
// metadata edit — it did, for this exact model, which is the case §E3 exists
// for — while 1% still separates the two by two orders of magnitude on either
// side. A different QUANT of the same model is further still (that model's Q6_K
// is 11% away), and the quant string is matched exactly anyway.
const SIZE_TOLERANCE = 0.01;

/** The one repo the evidence points at, or null. An EXACT byte match outranks
 *  every near one outright: it is proof that these are the same bytes, not a
 *  judgement about which account is more likely — and a repo that is merely
 *  close cannot out-argue it.
 *
 *  MEASURED on 2026-09-05, the case this exists for: this machine's
 *  Qwen3.5-2B-Q8_0.gguf is 2,012,012,800 bytes; unsloth publishes it at exactly
 *  that, and lmstudio-community publishes the same filename 800 bytes smaller.
 *  Both are inside SIZE_TOLERANCE, so without this the model would resolve to
 *  no repo at all even though one of the two is provably the source.
 *
 *  Ties never resolve. Two exact matches are byte-identical mirrors and two
 *  near ones are two guesses; either way no repo is written, because choosing
 *  between them would be exactly the guess this whole file refuses to make. */
function pickOne(
  confirmed: { repo: string; option: QuantOption }[], bytesOnDisk: number
): { repo: string; option: QuantOption } | null {
  const exact = confirmed.filter((m) => m.option.totalSizeBytes === bytesOnDisk);
  const pool = exact.length > 0 ? exact : confirmed;
  return pool.length === 1 ? pool[0] : null;
}

export function defaultBackfillLookups(userDataDir: string, fetchImpl?: typeof fetch): BackfillLookups {
  const curated = new CuratedCatalog(userDataDir, fetchImpl as any);
  const hf = new HfClient(fetchImpl as any);
  return {
    curated: () => curated.get(),
    search: (q) => hf.search(q),
    quantOptions: (repo) => hf.quantOptions(repo),
    now: () => Date.now(),
  };
}

/** The filename stem a curated entry's repo publishes its quants under:
 *  'unsloth/gemma-4-12b-it-GGUF' → 'gemma-4-12b-it', which is exactly what
 *  parseGgufName reads out of 'gemma-4-12b-it-UD-Q4_K_XL.gguf'. Exported for
 *  the test that pins it against the shipped list. */
export function curatedRepoStem(hfRepo: string): string {
  const name = hfRepo.split('/').pop() ?? hfRepo;
  return name.replace(/-GGUF$/i, '');
}

/** Every part's filename, derived from the first one. llama.cpp's split naming
 *  is positional (`<name>-000kk-of-000NN.gguf`), so the whole set is known from
 *  part 1 plus the count — which is all a MISS has to record. */
function partFileNames(c: BackfillCandidate): string[] {
  const suffix = /-(\d{5})-of-(\d{5})\.gguf$/i;
  const m = suffix.exec(c.firstFileName);
  if (!m || c.parts <= 1) return [c.firstFileName];
  const out: string[] = [];
  for (let i = 1; i <= c.parts; i++) {
    out.push(c.firstFileName.replace(suffix, `-${String(i).padStart(5, '0')}-of-${m[2]}.gguf`));
  }
  return out;
}

/** When the weights were last written — the closest honest reading of when this
 *  download actually finished, which is what `completedAt` means. */
function fileModifiedAt(file: string): number | null {
  try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; }
}

function keyOf(c: BackfillCandidate): string { return path.join(c.dir, c.firstFileName); }

export class ManifestBackfill {
  // The pass currently running, or null. One at a time, always — see the header.
  private pass: Promise<void> | null = null;
  // Every model this app run has already spent a lookup on, whatever the
  // outcome. A model that RESOLVED drops out on its own (it has a manifest now
  // and stops being a candidate); this set is what stops a model whose lookup
  // FAILED from being retried on every render of the Local Models screen. A new
  // app run starts with an empty set, which is the retry.
  private attempted = new Set<string>();

  constructor(private look: BackfillLookups) {}

  /** Hand over the complete downloads that have no manifest. Returns at once —
   *  the caller is a screen's data fetch and must not wait on the network. */
  kick(candidates: BackfillCandidate[]): void {
    if (this.pass) return;
    const todo = candidates.filter((c) => !this.attempted.has(keyOf(c)));
    if (todo.length === 0) return;
    // setImmediate, not a bare async call: an async function body runs
    // synchronously up to its first await, and CuratedCatalog reads its disk
    // cache before awaiting anything. Deferring the whole thing keeps every
    // byte of this work off installedModels()' tick.
    this.pass = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.run(todo).then(() => {
          // Cleared BEFORE resolving, so anything awaiting whenIdle() can kick
          // a fresh pass the instant it wakes up.
          this.pass = null;
          resolve();
        });
      });
    });
  }

  /** Settles when the pass in flight is over. Used by the tests, which must
   *  await this before their fixture directory is torn down. */
  whenIdle(): Promise<void> { return this.pass ?? Promise.resolve(); }

  private async run(todo: BackfillCandidate[]): Promise<void> {
    for (const c of todo) {
      this.attempted.add(keyOf(c));
      try {
        await this.resolveOne(c);
      } catch {
        // The lookup could not FINISH — offline, a timeout, a rate limit, a
        // 5xx, an aborted request. Nothing is written, because a temporary
        // failure must never harden into the permanent `repo: null` record.
        // The next app run tries this model again.
      }
    }
  }

  private async resolveOne(c: BackfillCandidate): Promise<void> {
    const parsed = parseGgufName(c.firstFileName);
    // A filename we cannot read a quant out of. A manifest requires the exact
    // string Hugging Face uses, and inventing one would put a made-up value
    // where a real fact belongs — so this model is left alone, not recorded.
    if (!parsed) return;

    // 1. The curated list, offline. CuratedCatalog.get() never throws and falls
    //    back to the copy shipped inside the app, so a curated model resolves
    //    its repo with no search at all.
    const named = await this.curatedRepoFor(parsed.base, parsed.quant);
    if (named) {
      const option = await this.confirm(named, c, parsed.quant);
      if (option) { this.record(c, named, parsed.quant, option); return; }
      // The curated list NAMES this repo, but the repo does not hold this file
      // at this size — so these bytes did not come from there. Fall through to
      // the search rather than write a repo the evidence contradicts.
    }

    // 2. One search on the filename stem, then confirm what it returns. Every
    //    candidate is checked, with no early exit: a repo further down the list
    //    can be the EXACT byte match that settles the question, and stopping
    //    at the first two survivors would throw that answer away unread.
    const hits = await this.look.search(parsed.base);
    const repos = hits.map((h) => h.repo).filter((r) => r !== named).slice(0, MAX_SEARCH_CANDIDATES);
    const confirmed: { repo: string; option: QuantOption }[] = [];
    for (const repo of repos) {
      const option = await this.confirm(repo, c, parsed.quant);
      if (option) confirmed.push({ repo, option });
    }
    // Every lookup answered. Either one repo is picked out by the evidence, or
    // the honest record is "we looked and could not find it" — which is what
    // `repo: null` means, and what stops this search ever being repeated.
    const match = pickOne(confirmed, c.bytesPublished);
    this.record(c, match?.repo ?? null, parsed.quant, match?.option ?? null);
  }

  /** The curated entry that publishes this filename, if any. The match is two
   *  exact string equalities — the repo's own stem against the filename's, and
   *  the entry's default quant against the filename's quant. */
  private async curatedRepoFor(stem: string, quant: string): Promise<string | null> {
    const curated = await this.look.curated();
    const hit = curated.find((m) => curatedRepoStem(m.hfRepo) === stem && m.quantDefault === quant);
    return hit?.hfRepo ?? null;
  }

  /** Does this repo really hold the copy on disk? Four tests, in order, and a
   *  repo has to pass every one of them — this is the whole of "a wrong repo is
   *  impossible", together with the caller's rule that two survivors mean no
   *  repo is written:
   *    1. it offers this EXACT quant string ('Q8_0', 'UD-Q4_K_XL', …), so no
   *       other build of the same model can qualify;
   *    2. as EXACTLY this many parts, so half of a split set cannot pass;
   *    3. whose first file is called EXACTLY what the file on disk is called,
   *       which is the model's own name — so a repo that renames its files
   *       (bartowski prefixes them with the original account) is refused;
   *    4. at all but the same total size — within SIZE_TOLERANCE, which the
   *       measurement above shows separates a re-upload from another account's
   *       own quantization by two orders of magnitude.
   *  There is no fuzzy name matching anywhere, and nothing is inferred from
   *  which repo is more popular. */
  private async confirm(
    repo: string, c: BackfillCandidate, quant: string
  ): Promise<QuantOption | null> {
    const options = await this.look.quantOptions(repo);
    const option = options.find((o) => o.quant === quant);
    if (!option) return null;
    if (option.files.length !== c.parts) return null;
    if ((option.files[0].split('/').pop() ?? option.files[0]) !== c.firstFileName) return null;
    if (Math.abs(option.totalSizeBytes - c.bytesPublished) > c.bytesPublished * SIZE_TOLERANCE) return null;
    return option;
  }

  private record(
    c: BackfillCandidate, repo: string | null, quant: string, option: QuantOption | null
  ): void {
    const at = fileModifiedAt(path.join(c.dir, c.firstFileName)) ?? this.look.now();
    // On a hit these are the repo-relative paths a real download would have
    // written (unsloth keeps dynamic quants in subfolders); on a miss the only
    // names anyone knows are the ones on disk.
    const files = option ? option.files : partFileNames(c);
    const manifest: DownloadManifest = {
      v: 1,
      repo,
      quant,
      files,
      totalSizeBytes: option?.totalSizeBytes ?? c.bytesPublished,
      // No hashes for a miss: Hugging Face is the only source of them and we
      // never reached it. null per file is what "not known" already means here.
      sha256ByFile: option?.sha256ByFile ?? Object.fromEntries(files.map((f) => [f, null])),
      // This download finished in the past and nothing recorded when. The
      // weights' own mtime is the closest honest reading; both fields carry it,
      // because a completed manifest's startedAt is never read for anything
      // else and a fabricated "started now" would read as a live download.
      startedAt: at,
      completedAt: at,
      ...(option?.visionFile ? { visionFile: option.visionFile } : {}),
    };
    writeBackfillManifest(c.dir, c.firstFileName, manifest);
  }
}
