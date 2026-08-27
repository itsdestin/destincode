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
import { Button, InputGroup, ProgressBar, Callout } from './ui';
import type {
  CuratedModel, QuantOption, FitEstimate, DownloadProgress,
  InstalledLocalModel, DetectedEndpoint, HFSearchHit,
} from '../../shared/model-manager-types';

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
        <button
          onClick={() => void window.claude.models.downloadCancel(dl.downloadId)}
          className="text-3xs font-medium text-red-500 hover:underline"
        >
          Cancel
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
  const matches = (...fields: (string | null | undefined)[]) =>
    !q || fields.some((f) => (f ?? '').toLowerCase().includes(q));

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
              {hfState === 'error' && <p className="text-2xs text-destructive-fg px-1">Couldn't reach Hugging Face.</p>}
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
      {dlError && <p className="text-3xs text-destructive-fg mt-1">{dlError}</p>}

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
 *  unknown (an untraceable row) — the caller then shows NO percentage rather
 *  than inventing a denominator. */
function percentOf(onDisk: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(100, Math.round((onDisk / total) * 100));
}

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
      // If a download of this model is still live, cancel it and AWAIT the
      // 'cancelled' event FIRST — removing the .partial out from under an open
      // write stream races.
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

  // Spec §3.2: an unfinished download is DISCARDED; a model (complete, or one
  // we can't resume) is DELETED. Destin decides at the workbench gate whether
  // one word should serve both.
  const removeLabel = model.status === 'unfinished' ? 'Discard' : 'Delete';

  const subtitle =
    live
      ? `${live.state === 'verifying' ? 'Verifying…' : 'Downloading…'} · ${pct ?? 0}% — ${gbNum(onDisk)} of ${gb(total ?? 0)}`
        + (live.parts > 1 ? ` · part ${live.currentPart} of ${live.parts}` : '')
    : model.status === 'complete'
      ? [gb(model.sizeBytes), model.quant, model.quantDescription].filter(Boolean).join(' · ')
    : model.status === 'unfinished' && pct != null
      ? `${pct}% — ${gbNum(onDisk)} of ${gb(total ?? 0)}`
    : `Unfinished — ${gb(model.sizeBytes)} downloaded`;

  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg font-medium truncate">{model.id}</p>
          <p className="text-3xs text-fg-muted">{subtitle}</p>
        </div>
        {!confirming && (
          <div className="flex items-center gap-1.5 shrink-0">
            {model.status === 'unfinished' && !live && (
              <Button variant="secondary" size="sm" onClick={() => void resume()} disabled={busy}>
                Resume
              </Button>
            )}
            {live && (
              // Same word as the RepoCard's in-flight control (DownloadProgressRow):
              // one download, one verb wherever it appears.
              <Button variant="secondary" size="sm" onClick={() => void window.claude.models.downloadCancel(live.downloadId)}>
                Cancel
              </Button>
            )}
            <Button variant="danger-outline" size="sm" onClick={() => setConfirming(true)} disabled={busy} className="shrink-0">
              {removeLabel}
            </Button>
          </div>
        )}
      </div>

      {live && (
        <div className="mt-2">
          <ProgressBar percent={pct ?? 0} aria-label="Download progress" />
        </div>
      )}

      {/* An untraceable row is NOT a dead end — say what to do about it. */}
      {model.status === 'untraceable' && !confirming && (
        <p className="text-3xs text-fg-muted mt-1">
          This download started before the app kept track of where downloads come from.
          Find the model in search and download it again — it will continue from where it stopped.
        </p>
      )}

      {/* Consequence-gated removal — plain-language warning naming the real size. */}
      {confirming && (
        <div className="mt-2 space-y-2">
          <Callout tone="danger">
            {model.status === 'complete'
              ? `This removes the model file (${gb(model.sizeBytes)}) from this computer. Re-downloading it later will take a while.`
              : `${removeLabel} ${gb(model.sizeBytes)}? This removes every downloaded piece of this model.`}
          </Callout>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)} className="flex-1">
              Keep
            </Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy} className="flex-1">
              {busy ? 'Removing…' : model.status === 'complete' ? 'Delete model' : `${removeLabel} download`}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-3xs text-destructive-fg mt-1">{error}</p>}
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
      {dlError && <p className="text-3xs text-destructive-fg mt-1">{dlError}</p>}
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
                        <p className="text-3xs text-destructive-fg mt-0.5">{addError[hit.baseUrl]}</p>
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
