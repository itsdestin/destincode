// Settings → Local Models (Phase 1 Plan C, Task 9). The in-app local-model
// manager: engine controls, ONE search-driven model browser (recommended +
// installed by default, filtering + Hugging Face search as you type), and
// detectors for other local apps (Ollama / LM Studio). Desktop-only surface —
// the whole section is gated on window.claude.native.supported so production
// builds (native.supported false until Phase 2) render nothing.
//
// Styling mirrors ProvidersSection: the panel's row cards are the shared
// in-panel row surface (bg-inset/50, borderless — change 25; they were
// bg-well + border-edge-dim), plain-word status (never ●◐○ glyphs),
// consequence-gated destructive actions.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import EngineCard from './EngineCard';
import { Button, FieldError, InputGroup, ProgressBar, Callout, AnchorTip } from './ui';
import type {
  CuratedModel, QuantOption, FitEstimate, DownloadProgress,
  InstalledLocalModel, DetectedEndpoint, HFSearchHit,
} from '../../shared/model-manager-types';
import { stripSplitSuffix } from '../../shared/gguf-split';
import { matchesQuery } from '../../shared/text-match';
import { resolveModelBrand } from './provider-brand';
import { ProviderIcon } from './ProviderIcon';

// quants() decorates every option with a GPU-aware fit label.
type QuantWithFit = QuantOption & { fit: FitEstimate };

// Bytes → GB with one decimal (binary GiB, consistent with EngineCard's MB).
function gb(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

// The number alone, for "74.2 of 113.0 GB" — one unit at the end of the phrase.
function gbNum(bytes: number): string {
  return (bytes / 1073741824).toFixed(1);
}

// Fit → a status color. These are theme-independent status colors (the app's
// standing rule keeps green/amber/red hardcoded); the label text is plain words
// straight from the estimator.
function fitColor(fit: FitEstimate['fit']): string {
  return fit === 'fits' ? 'text-green-600' : fit === 'tight' ? 'text-amber-500' : 'text-red-500';
}

// The few quants a non-technical user should see first (spec §4 — a raw 15–24
// row list is hostile). Everything else hides behind "Show all N".
const RECOMMENDED_QUANTS = new Set(['UD-Q4_K_XL', 'Q4_K_M', 'Q8_0']);

const key = (repo: string, quant: string) => `${repo}::${quant}`;

export default function LocalModelsSection({ embedded = false }: { embedded?: boolean } = {}) {
  // Gate the ENTIRE section on native support (same pattern as ProvidersSection).
  const supported = window.claude?.native?.supported === true;

  // One download subscription for the whole section; routed to rows by downloadId.
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  // Full QuantOption objects, keyed repo::quant. download() takes the OBJECT
  // (not a string), and part-1-basename (for Discard's delete) comes from its
  // files[]. Populated whenever a card resolves its quants; shared with the browser.
  const quantOptsByKeyRef = useRef<Record<string, QuantWithFit>>({});

  const [curated, setCurated] = useState<CuratedModel[] | null>(null);
  const [installed, setInstalled] = useState<InstalledLocalModel[] | null>(null);

  const refreshInstalled = useCallback(async () => {
    try { setInstalled(await window.claude.models.installed() as InstalledLocalModel[]); }
    catch { setInstalled([]); }
  }, []);

  useEffect(() => {
    if (!supported) return;
    // Curated + installed load once; downloads stay live via the subscription.
    void window.claude.models.curated().then((c: any) => setCurated(c)).catch(() => setCurated([]));
    void refreshInstalled();
    const seen = new Set<string>();
    const off = window.claude.models.onDownloadProgress((p: DownloadProgress) => {
      setDownloads((prev) => ({ ...prev, [p.downloadId]: p }));
      // Refresh on the FIRST event for a download (a brand-new one has no row in
      // the list yet) and on every terminal state (spec §3.5a). No race: the
      // manifest is written synchronously inside start(), before any event.
      const first = !seen.has(p.downloadId);
      seen.add(p.downloadId);
      if (first || p.state === 'done' || p.state === 'error' || p.state === 'cancelled') {
        void refreshInstalled();
      }
    });
    return off;
  }, [supported, refreshInstalled]);

  if (!supported) return null;

  return (
    <section>
      {!embedded && (
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Local Models</h3>
      )}

      <div className="space-y-4">
        {/* Engine controls (install / backend / context length). */}
        <EngineCard showDetails />

        {/* One search-driven browser: installed + recommended by default, then
            filters those AND searches Hugging Face as the user types. Replaces
            the old separate Recommended / Installed / Add-from-HF sections. */}
        <ModelBrowser
          curated={curated}
          installed={installed}
          downloads={downloads}
          quantOptsByKeyRef={quantOptsByKeyRef}
          onRefreshInstalled={refreshInstalled}
        />

        {/* Other local apps (Ollama / LM Studio). */}
        <OtherLocalApps />
      </div>
    </section>
  );
}

// ── Shared download helpers ──────────────────────────────────────────────────

// The active (in-flight) download for a repo+quant, if any.
function activeDownload(downloads: Record<string, DownloadProgress>, repo: string, quant: string): DownloadProgress | undefined {
  return Object.values(downloads).find(
    (d) => d.repo === repo && d.quant === quant && (d.state === 'downloading' || d.state === 'verifying'),
  );
}

// A small progress line + Cancel, shared by cards and rows.
function DownloadProgressRow({ dl }: { dl: DownloadProgress }) {
  const pct = dl.totalBytes > 0 ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100)) : 0;
  return (
    <div className="mt-2 space-y-1">
      {/* Change 46: the fill here was the odd one out — every other bar in the
          app rounds it, this one left it square, so a part-downloaded model had
          a visibly different bar shape from a part-loaded one. */}
      <ProgressBar percent={pct} aria-label="Download progress" />
      <div className="flex items-center justify-between">
        <p className="text-3xs text-fg-muted">
          {dl.state === 'verifying' ? 'Verifying…' : `${gb(dl.receivedBytes)} of ${gb(dl.totalBytes)}`}
          {dl.parts > 1 ? ` · part ${dl.currentPart} of ${dl.parts}` : ''}
        </p>
        {/* "Pause", not "Cancel": stopping keeps every downloaded byte, and the
            row below uses the same word for the same action (Destin, 2026-08-27).
            No longer red — pausing destroys nothing. */}
        <button
          onClick={() => void window.claude.models.downloadCancel(dl.downloadId)}
          className="text-3xs font-medium text-fg-muted hover:text-fg hover:underline"
        >
          Pause
        </button>
      </div>
    </div>
  );
}

// ── Model browser (recommended + installed + search, one filterable list) ────

function ModelBrowser({
  curated, installed, downloads, quantOptsByKeyRef, onRefreshInstalled,
}: {
  curated: CuratedModel[] | null;
  installed: InstalledLocalModel[] | null;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  onRefreshInstalled: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  // Hugging Face results for the current query (null = not searched this query).
  const [hfHits, setHfHits] = useState<HFSearchHit[] | null>(null);
  const [hfState, setHfState] = useState<'idle' | 'loading' | 'error'>('idle');
  // Which repo is expanded to reveal its full quant list (one at a time).
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);

  // Debounced Hugging Face search. Empty/short query clears HF results so the
  // list falls back to installed + recommended only.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHfHits(null); setHfState('idle'); return; }
    let alive = true;
    setHfState('loading');
    const t = setTimeout(async () => {
      try {
        const hits = await window.claude.models.search(q) as HFSearchHit[];
        if (alive) { setHfHits(hits); setHfState('idle'); }
      } catch {
        if (alive) { setHfHits([]); setHfState('error'); }
      }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  const q = query.trim().toLowerCase();
  // Word-by-word and punctuation-insensitive, so "qwen 30b" finds "qwen3-30b".
  const matches = (...fields: (string | null | undefined)[]) => matchesQuery(q, ...fields);

  // Installed (filtered) + in-progress / partial downloads.
  const installedFiltered = (installed ?? []).filter((m) => matches(m.id, m.quant, m.quantDescription));
  // A download and its disk row are ONE row — matched on repo + quant, both of
  // which a resumable row carries from its manifest (spec §3.5a). The NEWEST
  // event wins, in any state: ulids sort by creation time, so after Resume the
  // fresh attempt's events replace the failed attempt's error line.
  const progressFor = (m: InstalledLocalModel): DownloadProgress | undefined =>
    m.repo
      ? Object.values(downloads)
        .filter((d) => d.repo === m.repo && d.quant === m.quant)
        .sort((a, b) => (a.downloadId < b.downloadId ? 1 : -1))[0]
      : undefined;

  // Recommended (filtered).
  const curatedFiltered = (curated ?? []).filter((m) => matches(m.label, m.hfRepo, m.notes));

  // Hugging Face matches that aren't already a recommended card (deduped).
  const curatedRepos = new Set((curated ?? []).map((c) => c.hfRepo.toLowerCase()));
  const hfFiltered = (hfHits ?? []).filter((h) => !curatedRepos.has(h.repo.toLowerCase()));

  const searching = q.length >= 2;
  const nothing =
    installedFiltered.length === 0 && curatedFiltered.length === 0 &&
    (!searching || (hfState === 'idle' && hfFiltered.length === 0));

  const toggle = (repo: string) => setExpandedRepo((cur) => (cur === repo ? null : repo));

  return (
    // Change 25: in-panel row surface, matching EngineCard and "Other local
    // apps" — the three are siblings in this panel and shared one class string.
    <div className="rounded-lg bg-inset/50 px-3 py-2.5">
      <p className="text-xs text-fg font-medium mb-2.5">Models</p>

      {/* Search — filters recommended/installed locally, searches Hugging Face. */}
      {/* Change 77: the clear-X was already an inside-the-field action, faked with
          `absolute` positioning plus a hand-tuned pr-8 to keep the text off it.
          InputGroup makes it a real inline child, so the reserved space can no
          longer drift out of sync with the icon. */}
      <InputGroup className="w-full mb-3">
        <InputGroup.Field
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models (e.g. qwen, llama)…"
          aria-label="Search models"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="shrink-0 px-1 text-fg-muted hover:text-fg"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </InputGroup>

      {curated === null || installed === null ? (
        <p className="text-2xs text-fg-muted px-1">Loading…</p>
      ) : (
        <div className="space-y-3">
          {/* Installed (+ in-progress) */}
          {installedFiltered.length > 0 && (
            <div className="space-y-2">
              <p className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Installed</p>
              {installedFiltered.map((m) => (
                <LocalModelRow key={m.id} model={m} progress={progressFor(m)} onRefresh={onRefreshInstalled} />
              ))}
            </div>
          )}

          {/* Recommended (label changes to "matches" while filtering) */}
          {curatedFiltered.length > 0 && (
            <div className="space-y-2">
              <p className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
                {q ? 'Recommended matches' : 'Recommended'}
              </p>
              {curatedFiltered.map((m) => (
                <RepoCard
                  key={m.id}
                  repo={m.hfRepo}
                  label={m.label}
                  sub={m.notes}
                  preferredQuant={m.quantDefault}
                  autoResolve            /* curated: resolve size/fit up front */
                  downloads={downloads}
                  quantOptsByKeyRef={quantOptsByKeyRef}
                  expanded={expandedRepo === m.hfRepo}
                  onToggle={() => toggle(m.hfRepo)}
                />
              ))}
            </div>
          )}

          {/* Hugging Face — only while actively searching */}
          {searching && (
            <div className="space-y-2">
              <p className="text-3xs font-medium text-fg-muted tracking-wider uppercase">More on Hugging Face</p>
              {hfState === 'loading' && <p className="text-2xs text-fg-muted px-1">Searching Hugging Face…</p>}
              {hfState === 'error' && <FieldError as="p" size="2xs" className="px-1">Couldn't reach Hugging Face.</FieldError>}
              {hfState === 'idle' && hfFiltered.length === 0 && (
                <p className="text-2xs text-fg-muted px-1">No other models found.</p>
              )}
              {hfFiltered.map((h) => (
                <RepoCard
                  key={h.repo}
                  repo={h.repo}
                  label={h.repo}
                  sub={`${h.downloads.toLocaleString()} downloads`}
                  autoResolve={false}    /* HF: resolve only when expanded (caps fan-out) */
                  downloads={downloads}
                  quantOptsByKeyRef={quantOptsByKeyRef}
                  expanded={expandedRepo === h.repo}
                  onToggle={() => toggle(h.repo)}
                />
              ))}
            </div>
          )}

          {nothing && <p className="text-2xs text-fg-muted px-1">No models match “{query}”.</p>}
        </div>
      )}
    </div>
  );
}

// One model repo — used for both recommended (autoResolve) and Hugging Face
// (resolve-on-expand) rows. Collapsed: name + a quick Download of the default
// quant. Expanded: the full quant list (recommended-first, "Show all N").
function RepoCard({
  repo, label, sub, preferredQuant, autoResolve, downloads, quantOptsByKeyRef, expanded, onToggle,
}: {
  repo: string;
  label: string;
  sub?: string;
  preferredQuant?: string;
  autoResolve: boolean;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [quants, setQuants] = useState<QuantWithFit[] | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [showAll, setShowAll] = useState(false);
  // WHY: download() throws the disk-guard refusal + "already downloading" —
  // surface them or the click is a silent no-op + a renderer unhandledrejection.
  const [dlError, setDlError] = useState<string | null>(null);

  const loadQuants = useCallback(async () => {
    setLoadState('loading');
    try {
      const opts = await window.claude.models.quants(repo) as QuantWithFit[];
      // Stash every option so download()/resume()/part1Id can resolve later.
      for (const o of opts) quantOptsByKeyRef.current[key(repo, o.quant)] = o;
      setQuants(opts);
      setLoadState('idle');
    } catch {
      setLoadState('error');
    }
  }, [repo, quantOptsByKeyRef]);

  // Curated cards resolve size/fit up front; HF cards resolve on first expand.
  // One dead repo can never blank the list — a rejected quants() shows a retry.
  useEffect(() => {
    if ((autoResolve || expanded) && quants === null && loadState === 'idle') void loadQuants();
  }, [autoResolve, expanded, quants, loadState, loadQuants]);

  // The default quant to quick-download: the preferred one, else a recommended
  // one, else the first.
  const chosen = quants
    ? ((preferredQuant && quants.find((o) => o.quant === preferredQuant))
        || quants.find((o) => RECOMMENDED_QUANTS.has(o.quant))
        || quants[0])
    : undefined;
  const dl = chosen ? activeDownload(downloads, repo, chosen.quant) : undefined;

  const startDefault = async () => {
    if (!chosen) return;
    setDlError(null);
    try { await window.claude.models.download(repo, chosen); }
    catch (e) { setDlError(e instanceof Error ? e.message : 'Could not start the download.'); }
  };

  // Recommended quants first; the rest hide behind "Show all N".
  const recommended = (quants ?? []).filter((x) => RECOMMENDED_QUANTS.has(x.quant));
  const rest = (quants ?? []).filter((x) => !RECOMMENDED_QUANTS.has(x.quant));
  const visible = showAll ? [...recommended, ...rest] : (recommended.length > 0 ? recommended : (quants ?? []).slice(0, 3));
  const hiddenCount = (quants ?? []).length - visible.length;

  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button onClick={onToggle} className="flex items-start gap-2 min-w-0 flex-1 text-left">
          <svg className={`w-3 h-3 mt-1 text-fg-muted transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <LocalBrandMark id={repo} />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-fg font-medium truncate">{label}</p>
            {sub && <p className="text-3xs text-fg-muted truncate">{sub}</p>}
            {loadState === 'loading' && quants === null && (
              <p className="text-3xs text-fg-muted mt-0.5">Checking size…</p>
            )}
            {chosen && (
              <p className="text-3xs mt-0.5">
                <span className="text-fg-dim">{gb(chosen.totalSizeBytes)} · {chosen.quant}</span>
                {' · '}
                <span className={fitColor(chosen.fit.fit)}>{chosen.fit.label}</span>
              </p>
            )}
            {loadState === 'error' && quants === null && (
              <p className="text-3xs text-amber-500 mt-0.5">Couldn't reach Hugging Face — expand to retry</p>
            )}
          </div>
        </button>
        {/* Inline row action -> sm, matching EngineCard's Install/Restart. */}
        {chosen && !dl && (
          <Button size="sm" onClick={() => void startDefault()} className="shrink-0">
            Download
          </Button>
        )}
      </div>
      {dl && <DownloadProgressRow dl={dl} />}
      {dlError && <FieldError as="p" className="mt-1">{dlError}</FieldError>}

      {/* Expanded: the full quant list. */}
      {expanded && (
        <div className="mt-2 pl-5">
          {loadState === 'loading' && <p className="text-3xs text-fg-muted px-1">Loading versions…</p>}
          {loadState === 'error' && (
            <button onClick={() => void loadQuants()} className="text-3xs text-amber-500 hover:underline px-1">
              Couldn't reach Hugging Face — tap to retry
            </button>
          )}
          {quants !== null && loadState !== 'loading' && (
            <div className="space-y-1.5">
              {visible.map((qq) => (
                <QuantDownloadRow key={qq.quant} repo={repo} q={qq} downloads={downloads} />
              ))}
              {!showAll && hiddenCount > 0 && (
                <button onClick={() => setShowAll(true)} className="text-3xs text-fg-2 hover:underline px-1">
                  Show all {(quants ?? []).length}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Local model rows ─────────────────────────────────────────────────────────

/** Percent of a download that is on disk. Returns null when the total is
 *  unknown (a damaged row) — the caller then shows NO percentage rather than
 *  inventing a denominator. */
function percentOf(onDisk: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(100, Math.round((onDisk / total) * 100));
}

/** The company mark for a local model row, matched off the repo/file name
 *  ("Qwen/Qwen3-30B…", "google/gemma-3…"). Local weights are published under the
 *  lab that trained them, so the name is a reliable signal; anything
 *  unrecognised renders no mark rather than a wrong one. */
function LocalBrandMark({ id }: { id: string }) {
  const b = resolveModelBrand(id, 'local-engine');
  if (!b?.icon) return null;
  return (
    // `self-start` + a 2px nudge, NOT the row's own alignment: the installed row
    // is a `items-center` flex, so without this the mark floated to the vertical
    // middle of a three-line block instead of sitting beside the name. Destin,
    // review deck 2026-08-31 (MB-6): "top left in-line with the name please, not
    // just on the left side generally". The 2px drops the 14px glyph onto the
    // optical centre of the 16px line box the name renders in.
    <span className="shrink-0 self-start mt-[2px] inline-flex items-center justify-center w-4" style={{ color: b.color }}>
      <ProviderIcon icon={b.icon} size={14} />
    </span>
  );
}

/** The name a person recognises, with the two machine suffixes stripped:
 *  the quality tag (now shown on its own line below) and the -00001-of-00004
 *  split marker (a split model is ONE model; its part count already appears in
 *  the progress line while it downloads). "Qwen3.5-9B-Q8_0" → "Qwen3.5-9B".
 *  Destin, 2026-08-27: quality belongs on the detail line, not in the title. */
function displayName(model: InstalledLocalModel): string {
  let name = stripSplitSuffix(model.id);
  if (model.quant) {
    const at = name.toLowerCase().lastIndexOf(`-${model.quant.toLowerCase()}`);
    if (at > 0) name = name.slice(0, at);
  }
  // Never return an empty title: a model whose whole id IS its quant keeps the id.
  return name || model.id;
}

/** The banner strip across the top of a row that is not simply "finished".
 *  Three states on the app's own status palette (globals.css:291-294 — the
 *  THREE colours it holds constant across every theme): green = moving,
 *  amber = stopped but you can carry on, red = stopped and you can't.
 *
 *  SOLID fill with BLACK text, and both halves of that were measured, not
 *  guessed (2026-08-27):
 *    - The first version used a 15% tint with coloured text. On Creme that
 *      scored 1.07:1 and on Light 1.14:1 — the label was invisible on both
 *      light themes while reading 5.62:1 on Midnight. A translucent strip
 *      takes its final colour from the theme behind it, so no single text
 *      colour can be safe in all six; a solid strip can.
 *    - The second version used white text on `amber-700`, assuming Tailwind's
 *      #B45309 (5.02:1). It is NOT: globals.css:294 remaps --color-amber-700
 *      to #FF9800, where white scores 2.06:1 — still failing. Black on the
 *      app's three status colours scores 9.74 / 7.56 / 4.98, so black it is.
 *  Deliberately `red-400` rather than `bg-destructive`: this is a STATUS
 *  indicator, not a destructive-action surface, and --destructive is
 *  community-overridable with no contrast guard. */
const ROW_BANNER = {
  downloading: {
    text: 'Downloading',
    strip: 'bg-green-400 text-black',
    border: 'border-green-400/40',
  },
  verifying: {
    text: 'Verifying',
    strip: 'bg-green-400 text-black',
    border: 'border-green-400/40',
  },
  interrupted: {
    text: 'Download interrupted',
    strip: 'bg-amber-700 text-black',
    border: 'border-amber-700/40',
  },
  damaged: {
    text: 'Damaged',
    strip: 'bg-red-400 text-black',
    border: 'border-red-400/40',
  },
} as const;

/** The band's outline: flat across the middle, then sweeping DOWN into each of
 *  the card's rounded corners so the two read as one shape.
 *
 *  The arc's ORIENTATION is the whole trick, and getting it backwards is what
 *  made the first attempt look like a blocky tab: each corner ellipse is centred
 *  at the INNER-BOTTOM of its wedge, so the arc leaves the flat run with a
 *  HORIZONTAL tangent (no step where they join) and meets the card's side edge
 *  with a VERTICAL one. Centring it at the outer corner instead flips both
 *  tangents and produces the notch.
 *
 *  Built from three mask layers rather than a drawn shape: a mask is
 *  colour-agnostic, so the three state colours stay ordinary background classes
 *  with their contrast untouched, and px-sized layers do not stretch with the
 *  panel the way an SVG scaled to width would.
 */
const BAND_H = 11;   // flat thickness across the middle
const BAND_SWEEP = 14;   // how far in from each end the curve starts
const BAND_DEPTH = 6;    // how far the ends drop below the flat run

const MASK = {
  image: [
    'linear-gradient(#000, #000)',
    `radial-gradient(${BAND_SWEEP}px ${BAND_DEPTH}px at 100% 100%, transparent 99%, #000 100%)`,
    `radial-gradient(${BAND_SWEEP}px ${BAND_DEPTH}px at 0 100%, transparent 99%, #000 100%)`,
  ].join(', '),
  size: `100% ${BAND_H}px, ${BAND_SWEEP}px ${BAND_DEPTH}px, ${BAND_SWEEP}px ${BAND_DEPTH}px`,
  position: 'top left, bottom left, bottom right',
  repeat: 'no-repeat',
};


// Exported (named) so tests can pin each row state without booting the whole
// LocalModelsSection (which needs the full models API mocked).
export function LocalModelRow({
  model, progress, onRefresh,
}: {
  model: InstalledLocalModel;
  /** The NEWEST download-progress event for this model this session, in ANY
   *  state — matched on repo + quant by the parent (spec §3.5a). Undefined
   *  when nothing has been downloaded this session. */
  progress?: DownloadProgress;
  onRefresh: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Failures of the buttons on this row (resume refused, delete failed).
  const [actionError, setActionError] = useState<string | null>(null);

  const live = progress && (progress.state === 'downloading' || progress.state === 'verifying')
    ? progress : undefined;
  const onDisk = live ? live.receivedBytes : model.sizeBytes;
  const total = live ? live.totalBytes : model.totalSizeBytes;
  const pct = percentOf(onDisk, total);

  // Every state except "finished" wears a banner, so the row's condition reads
  // before any number does. Only a complete model has none.
  const banner = live
    ? (live.state === 'verifying' ? ROW_BANNER.verifying : ROW_BANNER.downloading)
    : model.status === 'unfinished' ? ROW_BANNER.interrupted
    : model.status === 'untraceable' ? ROW_BANNER.damaged
    : null;

  // WHY a download's own failure is read from the progress stream: resume()
  // returns the moment the download STARTS, so a click handler never sees an
  // HTTP error or an integrity failure — those arrive later as an 'error'
  // event, and this line is the only place that message reaches the user.
  const downloadError = progress?.state === 'error' ? (progress.message ?? 'Download failed') : null;
  const error = actionError ?? downloadError;

  const resume = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await window.claude.models.resume(model.id);
      await onRefresh();
    } catch (e) {
      // Surface the real refusal (disk guard, already downloading, no manifest).
      // A resume that silently did nothing was the original PartialRow bug.
      setActionError(e instanceof Error ? e.message : 'Could not resume the download.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      // If the event stream still shows this download running, stop it and AWAIT
      // the 'cancelled' event FIRST — removing the .partial out from under an
      // open write stream races. The row hides Delete while a download is live
      // (Destin, 2026-08-27), so this is the guard for a STALE stream: progress
      // events lag the real download, and a click can land inside that window.
      if (live) {
        await new Promise<void>((resolve) => {
          const off = window.claude.models.onDownloadProgress((p: DownloadProgress) => {
            if (p.downloadId === live.downloadId && p.state === 'cancelled') { off(); resolve(); }
          });
          window.claude.models.downloadCancel(live.downloadId).catch(() => { off(); resolve(); });
          // Safety net so a lost cancelled event can't hang the button forever.
          setTimeout(() => { off(); resolve(); }, 5000);
        });
      }
      await window.claude.models.delete(model.id);
      setConfirming(false);
      await onRefresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete the model.');
    } finally {
      setBusy(false);
    }
  };

  // Quality tag + its plain-language gloss, now a line of its own for EVERY
  // state — an interrupted download used to be the only row that never said
  // which version of the model it was (Destin, 2026-08-27).
  const quality = [model.quant, model.quantDescription].filter(Boolean).join(' · ');

  // A bar is drawn whenever a download is short of its total — at rest as well
  // as in flight. A paused download used to render its progress as grey text
  // while the same row mid-download got a bar, which made the state hardest to
  // see exactly when it mattered most.
  const showBar = Boolean(live) || (model.status === 'unfinished' && pct != null);

  // The progress numbers ride ABOVE the bar, centred on it, rather than sitting
  // under the model name (Destin, 2026-08-27): they describe the bar, so they
  // belong with it. A row with no bar has nothing to caption, and shows its size
  // under the name as before.
  const progressText = showBar
    ? `${pct ?? 0}% — ${gbNum(onDisk)} of ${gb(total ?? 0)}`
      + (live && live.parts > 1 ? ` · part ${live.currentPart} of ${live.parts}` : '')
    : null;

  const subtitle = showBar ? null
    : model.status === 'complete' ? gb(model.sizeBytes)
    : `${gb(model.sizeBytes)} downloaded`;

  return (
    <div className={`rounded-lg bg-inset/50 overflow-hidden ${banner ? `border ${banner.border}` : ''}`.trim()}>
      {/* The banner names the state before any number is read — a stopped
          download is the thing this screen exists to make obvious. */}
      {/* An accent, not a surface (Destin, 2026-08-27): 9px type — the smallest
          size the app defines, and arbitrary text-[Npx] is banned (globals.css:299)
          — on 1px of padding with leading-none, so the band is about a third of
          the header it started as.
          The bottom edge runs FLAT across the width and rounds into the card's
          corners only at the two ends. rounded-b-lg is the SAME 12px the card
          itself uses (--radius-lg), so the band's ends echo the corner they sit
          in rather than introducing a second, competing curve.
          Two earlier shapes were built and rejected before this one: an ellipse
          clip tapering to points (the ends floated in mid-air above the corners)
          and its inverse, dipping into the corners (it read as a header again).
          WHY a SOLID fill and not a fade-to-transparent: a translucent strip
          takes its colour from the theme behind it, which is what made this
          label score 1.07:1 on Creme. Rounding removes fill without diluting
          it, so the contrast under the label is untouched. */}
      {banner && (
        <div
          // The silhouette Destin tuned on 2026-08-27 (sweep 8 / depth 6 / flat 11,
          // smoothed to a 14px sweep): FLAT across the middle, then curving DOWN
          // into each corner so the band and the card's corner read as one shape.
          //
          // Three mask layers unioned: the flat strip down to 11px, plus an
          // elliptical wedge at each bottom corner reaching 6px deeper. A MASK
          // rather than a drawn shape because the mask is colour-agnostic — the
          // three state colours stay ordinary background classes — and because
          // px-sized layers do not stretch with the panel, which an SVG scaled to
          // width would (the sweep would visibly distort on resize).
          // border-radius cannot do this: it only ever cuts a corner off, and
          // this corner has to bulge outward.
          style={{
            height: `${BAND_H + BAND_DEPTH}px`,
            WebkitMaskImage: MASK.image, maskImage: MASK.image,
            WebkitMaskSize: MASK.size, maskSize: MASK.size,
            WebkitMaskPosition: MASK.position, maskPosition: MASK.position,
            WebkitMaskRepeat: MASK.repeat, maskRepeat: MASK.repeat,
          }}
          className={`px-3 pt-px text-4xs leading-none font-medium tracking-wider uppercase text-center ${banner.strip}`}
        >
          {banner.text}
        </div>
      )}

      <div className="px-3 pt-2 pb-2">
        <div className="flex items-center justify-between gap-3">
          <LocalBrandMark id={model.id} />
          <div className="min-w-0 flex-1">
            {/* title= carries the full id on hover: the name is truncated by the
                buttons beside it, and the tail is what tells two builds apart.
                Native title is the app's documented tool for a plain hover hint
                (ui/AnchorTip.tsx header). */}
            <p className="text-xs text-fg font-medium truncate" title={model.id}>{displayName(model)}</p>
            {subtitle && <p className="text-3xs text-fg-muted">{subtitle}</p>}
            {/* Its own line, in full — Destin, 2026-08-27 (A3). It is free to wrap;
                the room came from the detail line above, which handed its state
                word ("Downloading…") to the banner. */}
            {quality && <p className="text-3xs text-fg-muted">{quality}</p>}
          </div>
          {!confirming && (
            <div className="flex items-center gap-1.5 shrink-0">
              {model.status === 'unfinished' && !live && (
                <Button variant="secondary" size="sm" onClick={() => void resume()} disabled={busy}>
                  Resume
                </Button>
              )}
              {live ? (
                // The ONLY control while bytes are moving. "Pause" rather than
                // "Cancel" because every downloaded byte is kept — that is the
                // whole point of this feature (Destin, 2026-08-27). Delete is
                // deliberately absent here: two stop-shaped buttons differing
                // only in whether you lose 74 GB is a mistake waiting to happen.
                <Button variant="secondary" size="sm" onClick={() => void window.claude.models.downloadCancel(live.downloadId)}>
                  Pause
                </Button>
              ) : (
                <Button variant="danger-outline" size="sm" onClick={() => setConfirming(true)} disabled={busy} className="shrink-0">
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>

        {showBar && (
          <div className="mt-1.5">
            {/* Centred directly over the bar it describes. */}
            <p className="text-3xs text-fg-muted text-center mb-0.5">{progressText}</p>
            <ProgressBar percent={pct ?? 0} aria-label="Download progress" />
          </div>
        )}

        {/* A damaged row is NOT a dead end — the way out lives behind the (i)
            rather than as a permanent paragraph under the least useful row. */}
        {model.status === 'untraceable' && !confirming && (
          <div className="mt-1.5 flex items-center gap-1">
            <AnchorTip label="Why this download is damaged" title="Damaged download" widthClass="w-72">
              This download started before the app kept track of where downloads come from,
              so it can&rsquo;t be resumed automatically. Find the model in search and download
              it again — it will continue from where it stopped.
            </AnchorTip>
            <span className="text-3xs text-fg-muted">Why can&rsquo;t this be resumed?</span>
          </div>
        )}

        {/* Consequence-gated removal — plain-language warning naming the real size. */}
        {confirming && (
          <div className="mt-2 space-y-2">
            <Callout tone="danger">
              {model.status === 'complete'
                ? `This removes the model file (${gb(model.sizeBytes)}) from this computer. Re-downloading it later will take a while.`
                : `Delete ${gb(model.sizeBytes)}? This removes every downloaded piece of this model.`}
            </Callout>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setConfirming(false)} className="flex-1">
                Keep
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy} className="flex-1">
                {busy ? 'Removing…' : model.status === 'complete' ? 'Delete model' : 'Delete download'}
              </Button>
            </div>
          </div>
        )}
        {error && <FieldError as="p" className="mt-1">{error}</FieldError>}
      </div>
    </div>
  );
}

function QuantDownloadRow({ repo, q, downloads }: { repo: string; q: QuantWithFit; downloads: Record<string, DownloadProgress> }) {
  const dl = activeDownload(downloads, repo, q.quant);
  // WHY: same as the repo card — the disk-guard / already-downloading throws
  // must reach the user instead of vanishing into an unhandledrejection.
  const [dlError, setDlError] = useState<string | null>(null);

  const startDownload = async () => {
    setDlError(null); // clear any prior failure before retrying
    try {
      await window.claude.models.download(repo, q);
    } catch (e) {
      setDlError(e instanceof Error ? e.message : 'Could not start the download.');
    }
  };

  return (
    <div className="px-2 py-1.5 rounded-md bg-well">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-2xs text-fg font-medium">{q.quant}</p>
          <p className="text-3xs text-fg-muted">{q.description}</p>
          <p className="text-3xs mt-0.5">
            <span className="text-fg-dim">{gb(q.totalSizeBytes)}</span>
            {' · '}
            <span className={fitColor(q.fit.fit)}>{q.fit.label}</span>
          </p>
        </div>
        {!dl && (
          <Button size="sm" onClick={() => void startDownload()} className="shrink-0">
            Download
          </Button>
        )}
      </div>
      {dl && <DownloadProgressRow dl={dl} />}
      {dlError && <FieldError as="p" className="mt-1">{dlError}</FieldError>}
    </div>
  );
}

// ── Other local apps ──────────────────────────────────────────────────────────

const APP_NAME: Record<DetectedEndpoint['kind'], string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

function OtherLocalApps() {
  const [hits, setHits] = useState<DetectedEndpoint[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  // WHY: an upsert failure used to be a silent no-op — surface it per hit.
  const [addError, setAddError] = useState<Record<string, string>>({});

  const detect = async () => {
    setDetecting(true);
    try { setHits(await window.claude.models.detectEndpoints() as DetectedEndpoint[]); }
    catch { setHits([]); }
    finally { setDetecting(false); }
  };

  const addEndpoint = async (hit: DetectedEndpoint) => {
    // Register the detected server as an openai-compatible provider — the user
    // then manages it in the Providers section above.
    setAddError((prev) => { const n = { ...prev }; delete n[hit.baseUrl]; return n; });
    try {
      await window.claude.providers.upsert({
        type: 'openai-compatible',
        label: hit.label,
        baseUrl: hit.baseUrl,
        enabled: true,
      });
      setAdded((prev) => ({ ...prev, [hit.baseUrl]: true }));
    } catch (e) {
      setAddError((prev) => ({ ...prev, [hit.baseUrl]: e instanceof Error ? e.message : 'Could not add this endpoint.' }));
    }
  };

  return (
    // Change 25: in-panel row surface — see the "Models" card above.
    <div className="rounded-lg bg-inset/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg font-medium">Other local apps</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void detect()}
          disabled={detecting}
          className="shrink-0"
        >
          {detecting ? 'Detecting…' : 'Detect'}
        </Button>
      </div>

      {hits !== null && (
        hits.length === 0 ? (
          <p className="text-2xs text-fg-muted mt-2 px-1">No other local model apps found running.</p>
        ) : (
          <div className="space-y-2 mt-2">
            {hits.map((hit) => {
              const isAdded = hit.alreadyAdded || added[hit.baseUrl];
              return (
                <div key={hit.baseUrl} className="bg-inset/50 rounded-lg px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-fg">
                        {APP_NAME[hit.kind]} is running on this computer
                        {hit.modelCount != null ? ` (${hit.modelCount} models)` : ''}
                      </p>
                      {isAdded && (
                        <p className="text-3xs text-fg-muted mt-0.5">Added — manage it in Providers above.</p>
                      )}
                      {addError[hit.baseUrl] && (
                        <FieldError as="p" className="mt-0.5">{addError[hit.baseUrl]}</FieldError>
                      )}
                    </div>
                    {!isAdded && (
                      <Button size="sm" onClick={() => void addEndpoint(hit)} className="shrink-0">
                        Add as endpoint
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
