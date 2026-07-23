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
import { Button, InputGroup } from './ui';
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
    const off = window.claude.models.onDownloadProgress((p: DownloadProgress) => {
      setDownloads((prev) => ({ ...prev, [p.downloadId]: p }));
      // A finished download becomes an installed model — refresh that list.
      if (p.state === 'done') void refreshInstalled();
    });
    return off;
  }, [supported, refreshInstalled]);

  if (!supported) return null;

  return (
    <section>
      {!embedded && (
        <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Local Models</h3>
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
          setDownloads={setDownloads}
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
      <div className="h-1.5 rounded-full bg-inset overflow-hidden">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-fg-muted">
          {dl.state === 'verifying' ? 'Verifying…' : `${gb(dl.receivedBytes)} of ${gb(dl.totalBytes)}`}
          {dl.parts > 1 ? ` · part ${dl.currentPart} of ${dl.parts}` : ''}
        </p>
        <button
          onClick={() => void window.claude.models.downloadCancel(dl.downloadId)}
          className="text-[10px] font-medium text-red-500 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Model browser (recommended + installed + search, one filterable list) ────

function ModelBrowser({
  curated, installed, downloads, quantOptsByKeyRef, onRefreshInstalled, setDownloads,
}: {
  curated: CuratedModel[] | null;
  installed: InstalledLocalModel[] | null;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  onRefreshInstalled: () => Promise<void>;
  setDownloads: React.Dispatch<React.SetStateAction<Record<string, DownloadProgress>>>;
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
  const partials = Object.values(downloads).filter((d) => d.state !== 'done' && matches(d.repo, d.quant));

  // Recommended (filtered).
  const curatedFiltered = (curated ?? []).filter((m) => matches(m.label, m.hfRepo, m.notes));

  // Hugging Face matches that aren't already a recommended card (deduped).
  const curatedRepos = new Set((curated ?? []).map((c) => c.hfRepo.toLowerCase()));
  const hfFiltered = (hfHits ?? []).filter((h) => !curatedRepos.has(h.repo.toLowerCase()));

  const searching = q.length >= 2;
  const nothing =
    installedFiltered.length === 0 && partials.length === 0 && curatedFiltered.length === 0 &&
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
        <p className="text-[11px] text-fg-muted px-1">Loading…</p>
      ) : (
        <div className="space-y-3">
          {/* Installed (+ in-progress) */}
          {(installedFiltered.length > 0 || partials.length > 0) && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">Installed</p>
              {installedFiltered.map((m) => (
                <InstalledRow key={m.id} model={m} onRefresh={onRefreshInstalled} />
              ))}
              {partials.map((dl) => (
                <PartialRow
                  key={dl.downloadId}
                  dl={dl}
                  quantOptsByKeyRef={quantOptsByKeyRef}
                  onRefresh={onRefreshInstalled}
                  setDownloads={setDownloads}
                />
              ))}
            </div>
          )}

          {/* Recommended (label changes to "matches" while filtering) */}
          {curatedFiltered.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">
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
              <p className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">More on Hugging Face</p>
              {hfState === 'loading' && <p className="text-[11px] text-fg-muted px-1">Searching Hugging Face…</p>}
              {hfState === 'error' && <p className="text-[11px] text-destructive-fg px-1">Couldn't reach Hugging Face.</p>}
              {hfState === 'idle' && hfFiltered.length === 0 && (
                <p className="text-[11px] text-fg-muted px-1">No other models found.</p>
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

          {nothing && <p className="text-[11px] text-fg-muted px-1">No models match “{query}”.</p>}
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
            {sub && <p className="text-[10px] text-fg-muted truncate">{sub}</p>}
            {loadState === 'loading' && quants === null && (
              <p className="text-[10px] text-fg-muted mt-0.5">Checking size…</p>
            )}
            {chosen && (
              <p className="text-[10px] mt-0.5">
                <span className="text-fg-dim">{gb(chosen.totalSizeBytes)} · {chosen.quant}</span>
                {' · '}
                <span className={fitColor(chosen.fit.fit)}>{chosen.fit.label}</span>
              </p>
            )}
            {loadState === 'error' && quants === null && (
              <p className="text-[10px] text-amber-500 mt-0.5">Couldn't reach Hugging Face — expand to retry</p>
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
      {dlError && <p className="text-[10px] text-destructive-fg mt-1">{dlError}</p>}

      {/* Expanded: the full quant list. */}
      {expanded && (
        <div className="mt-2 pl-5">
          {loadState === 'loading' && <p className="text-[10px] text-fg-muted px-1">Loading versions…</p>}
          {loadState === 'error' && (
            <button onClick={() => void loadQuants()} className="text-[10px] text-amber-500 hover:underline px-1">
              Couldn't reach Hugging Face — tap to retry
            </button>
          )}
          {quants !== null && loadState !== 'loading' && (
            <div className="space-y-1.5">
              {visible.map((qq) => (
                <QuantDownloadRow key={qq.quant} repo={repo} q={qq} downloads={downloads} />
              ))}
              {!showAll && hiddenCount > 0 && (
                <button onClick={() => setShowAll(true)} className="text-[10px] text-fg-2 hover:underline px-1">
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

// ── Installed rows ───────────────────────────────────────────────────────────

function InstalledRow({ model, onRefresh }: { model: InstalledLocalModel; onRefresh: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // WHY: a failed delete used to leave the confirm strip open with no feedback.
  const [delError, setDelError] = useState<string | null>(null);

  const doDelete = async () => {
    setBusy(true);
    setDelError(null);
    try {
      await window.claude.models.delete(model.id);
      setConfirming(false);
      await onRefresh();
    } catch (e) {
      setDelError(e instanceof Error ? e.message : 'Could not delete the model.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg font-medium truncate">{model.id}</p>
          <p className="text-[10px] text-fg-muted">
            {gb(model.sizeBytes)}
            {model.quant ? ` · ${model.quant}` : ''}
            {model.quantDescription ? ` · ${model.quantDescription}` : ''}
          </p>
        </div>
        {!confirming && (
          <Button variant="danger-outline" onClick={() => setConfirming(true)} className="shrink-0">
            Delete
          </Button>
        )}
      </div>

      {/* Consequence-gated delete — plain-language warning before the file is removed. */}
      {confirming && (
        <div className="mt-2 space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
          <p className="text-[11px] text-fg-dim leading-relaxed">
            This removes the model file ({gb(model.sizeBytes)}) from this computer. Re-downloading it later will take a while.
          </p>
          <div className="flex gap-2">
            {/* Keep collapses the confirm rather than closing anything, so it
                survives the "no redundant text cancel" rule. */}
            <Button variant="secondary" onClick={() => setConfirming(false)} className="flex-1">
              Keep
            </Button>
            <Button
              variant="danger"
              onClick={() => void doDelete()}
              disabled={busy}
              className="flex-1"
            >
              {busy ? 'Deleting…' : 'Delete model'}
            </Button>
          </div>
          {delError && <p className="text-[10px] text-destructive-fg">{delError}</p>}
        </div>
      )}
    </div>
  );
}

function PartialRow({
  dl, quantOptsByKeyRef, onRefresh, setDownloads,
}: {
  dl: DownloadProgress;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  onRefresh: () => Promise<void>;
  setDownloads: React.Dispatch<React.SetStateAction<Record<string, DownloadProgress>>>;
}) {
  const [busy, setBusy] = useState(false);
  const isLive = dl.state === 'downloading' || dl.state === 'verifying';

  // The router-served id of part 1 (basename minus .gguf) — deleteModel removes
  // every sibling part's .gguf AND .gguf.partial from that id.
  const part1Id = (): string | null => {
    const opt = quantOptsByKeyRef.current[key(dl.repo, dl.quant)];
    if (!opt || opt.files.length === 0) return null;
    const base = opt.files[0].split('/').pop() ?? '';
    return base.replace(/\.gguf$/i, '') || null;
  };

  const resume = async () => {
    setBusy(true);
    try {
      let opt: QuantWithFit | undefined = quantOptsByKeyRef.current[key(dl.repo, dl.quant)];
      if (!opt) {
        // The option cache is per-session; a partial from a prior session needs
        // a fresh quants() to reconstruct the QuantOption download() expects.
        try {
          const opts = await window.claude.models.quants(dl.repo) as QuantWithFit[];
          for (const o of opts) quantOptsByKeyRef.current[key(dl.repo, o.quant)] = o;
          opt = opts.find((o) => o.quant === dl.quant);
        } catch { /* leave opt undefined — resume just no-ops below */ }
      }
      if (opt) await window.claude.models.download(dl.repo, opt); // resumes from the .partial
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      // If the download is still live, cancel it and AWAIT the 'cancelled' event
      // FIRST — rm-ing the .partial out from under an open writestream races.
      if (isLive) {
        await new Promise<void>((resolve) => {
          const off = window.claude.models.onDownloadProgress((p: DownloadProgress) => {
            if (p.downloadId === dl.downloadId && p.state === 'cancelled') { off(); resolve(); }
          });
          window.claude.models.downloadCancel(dl.downloadId).catch(() => { off(); resolve(); });
          // Safety net so a lost cancelled event can't hang the button forever.
          setTimeout(() => { off(); resolve(); }, 5000);
        });
      }
      const id = part1Id();
      if (id) await window.claude.models.delete(id);
      // Drop this download from the section map and refresh installed.
      setDownloads((prev) => { const n = { ...prev }; delete n[dl.downloadId]; return n; });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const label =
    dl.state === 'error' ? (dl.message ?? 'Download failed')
    : dl.state === 'cancelled' ? 'Paused'
    : dl.state === 'verifying' ? 'Verifying…'
    : 'Downloading…';

  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg font-medium truncate">{dl.repo}</p>
          <p className="text-[10px] text-fg-muted">
            {dl.quant} · {label}
            {dl.totalBytes > 0 ? ` · ${gb(dl.receivedBytes)} of ${gb(dl.totalBytes)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="secondary" size="sm" onClick={() => void resume()} disabled={busy}>
            Resume
          </Button>
          {/* Discard deletes the partial file on disk -> danger-outline. The
              hand-rolled red-500/40 border becomes the --destructive token, so
              community packs can restyle it (#C62828 today — no longer identical
              to the fixed status red #DD4444, which stayed put). */}
          <Button variant="danger-outline" size="sm" onClick={() => void discard()} disabled={busy}>
            Discard
          </Button>
        </div>
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
          <p className="text-[11px] text-fg font-medium">{q.quant}</p>
          <p className="text-[10px] text-fg-muted">{q.description}</p>
          <p className="text-[10px] mt-0.5">
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
      {dlError && <p className="text-[10px] text-destructive-fg mt-1">{dlError}</p>}
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
          <p className="text-[11px] text-fg-muted mt-2 px-1">No other local model apps found running.</p>
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
                        <p className="text-[10px] text-fg-muted mt-0.5">Added — manage it in Providers above.</p>
                      )}
                      {addError[hit.baseUrl] && (
                        <p className="text-[10px] text-destructive-fg mt-0.5">{addError[hit.baseUrl]}</p>
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
