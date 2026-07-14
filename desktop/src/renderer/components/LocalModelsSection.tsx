// Settings → Local Models (Phase 1 Plan C, Task 9). The in-app local-model
// manager: engine controls, a curated catalog, installed models, a Hugging Face
// search, and detectors for other local apps (Ollama / LM Studio). Desktop-only
// surface — the whole section is gated on window.claude.native.supported so
// production builds (native.supported false until Phase 2) render nothing.
//
// Styling mirrors ProvidersSection: bg-well / bg-inset cards, border-edge-dim,
// plain-word status (never ●◐○ glyphs), consequence-gated destructive actions.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import EngineCard from './EngineCard';
import type {
  CuratedModel, QuantOption, FitEstimate, DownloadProgress,
  InstalledLocalModel, DetectedEndpoint, HFSearchHit, ModelTier,
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

const TIERS: { tier: ModelTier; label: string }[] = [
  { tier: 'small', label: 'Small' },
  { tier: 'everyday', label: 'Everyday' },
  { tier: 'large', label: 'Large' },
];

// The few quants a non-technical user should see first (spec §4 — a raw 15–24
// row list is hostile). Everything else hides behind "Show all N".
const RECOMMENDED_QUANTS = new Set(['UD-Q4_K_XL', 'Q4_K_M', 'Q8_0']);

const key = (repo: string, quant: string) => `${repo}::${quant}`;

// Per-curated-card resolution state (size + fit resolved LAZILY per repo).
type CardState =
  | { state: 'loading' }
  | { state: 'ready'; chosen: QuantWithFit }
  | { state: 'unavailable' };

export default function LocalModelsSection() {
  // Gate the ENTIRE section on native support (same pattern as ProvidersSection).
  const supported = window.claude?.native?.supported === true;

  // ── Download progress (section-level, routed to cards/rows by downloadId) ──
  // One subscription; every card + installed in-progress row reads this map.
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  // Full QuantOption objects, keyed repo::quant. download() takes the OBJECT
  // (not a string), and part-1-basename (for Discard's delete) comes from its
  // files[]. Populated whenever we fetch quants (card fetch or search expand).
  const quantOptsByKeyRef = useRef<Record<string, QuantWithFit>>({});

  const [curated, setCurated] = useState<CuratedModel[] | null>(null);
  const [installed, setInstalled] = useState<InstalledLocalModel[] | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const cardsRef = useRef<Record<string, CardState>>({}); // mirror for dedup

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

  const setCard = useCallback((repo: string, val: CardState) => {
    cardsRef.current = { ...cardsRef.current, [repo]: val };
    setCards(cardsRef.current);
  }, []);

  // Resolve a curated card's default-quant size + fit lazily. Skips a repo that
  // is already loading/ready (unless forced by a retry tap). One dead repo can
  // never blank the whole section — a rejected quants() maps to 'unavailable'.
  const fetchQuantsFor = useCallback(async (model: CuratedModel, force = false) => {
    const repo = model.hfRepo;
    const cur = cardsRef.current[repo];
    if (!force && cur && (cur.state === 'loading' || cur.state === 'ready')) return;
    setCard(repo, { state: 'loading' });
    try {
      const opts = await window.claude.models.quants(repo) as QuantWithFit[];
      // Stash every option so download()/resume()/part1Id can resolve later.
      for (const o of opts) quantOptsByKeyRef.current[key(repo, o.quant)] = o;
      const chosen = opts.find((o) => o.quant === model.quantDefault) ?? opts[0];
      setCard(repo, chosen ? { state: 'ready', chosen } : { state: 'unavailable' });
    } catch {
      setCard(repo, { state: 'unavailable' });
    }
  }, [setCard]);

  if (!supported) return null;

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Local Models</h3>

      <div className="space-y-4">
        {/* 1 — Engine card (with the Plan C detail controls). */}
        <EngineCard showDetails />

        {/* 2 — Recommended models, grouped by tier. */}
        <RecommendedModels
          curated={curated}
          cards={cards}
          downloads={downloads}
          quantOptsByKeyRef={quantOptsByKeyRef}
          onEnsureQuants={fetchQuantsFor}
        />

        {/* 3 — Installed models + in-progress/partial downloads. */}
        <InstalledModels
          installed={installed}
          downloads={downloads}
          quantOptsByKeyRef={quantOptsByKeyRef}
          onRefresh={refreshInstalled}
          setDownloads={setDownloads}
        />

        {/* 4 — Add from Hugging Face (search). */}
        <HuggingFaceSearch
          downloads={downloads}
          quantOptsByKeyRef={quantOptsByKeyRef}
        />

        {/* 5 — Other local apps (Ollama / LM Studio). */}
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

// A small progress line + Cancel, shared by cards and search rows.
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

// ── 2. Recommended models ────────────────────────────────────────────────────

function RecommendedModels({
  curated, cards, downloads, quantOptsByKeyRef, onEnsureQuants,
}: {
  curated: CuratedModel[] | null;
  cards: Record<string, CardState>;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  onEnsureQuants: (model: CuratedModel, force?: boolean) => Promise<void>;
}) {
  // Expand the FIRST non-empty tier by default so the panel shows content
  // without a click, but the others stay collapsed to cap the quants() fan-out.
  const [expanded, setExpanded] = useState<Record<ModelTier, boolean>>({ small: false, everyday: false, large: false });
  const didInit = useRef(false);

  const modelsFor = useCallback((tier: ModelTier) => (curated ?? []).filter((m) => m.tier === tier), [curated]);

  // Default-expand + fetch the first non-empty tier once curated lands.
  useEffect(() => {
    if (!curated || didInit.current) return;
    const first = TIERS.find(({ tier }) => modelsFor(tier).length > 0);
    if (!first) { didInit.current = true; return; }
    didInit.current = true;
    setExpanded((prev) => ({ ...prev, [first.tier]: true }));
    for (const m of modelsFor(first.tier)) void onEnsureQuants(m);
  }, [curated, modelsFor, onEnsureQuants]);

  const toggleTier = (tier: ModelTier) => {
    setExpanded((prev) => {
      const next = !prev[tier];
      // On first expand, resolve size + fit for that tier's cards only.
      if (next) for (const m of modelsFor(tier)) void onEnsureQuants(m);
      return { ...prev, [tier]: next };
    });
  };

  return (
    <div className="rounded-lg border border-edge-dim bg-well px-3 py-2.5">
      <p className="text-xs text-fg font-medium mb-2">Recommended models</p>
      {curated === null ? (
        <p className="text-[11px] text-fg-muted px-1">Loading…</p>
      ) : curated.length === 0 ? (
        <p className="text-[11px] text-fg-muted px-1">No recommendations available.</p>
      ) : (
        <div className="space-y-3">
          {TIERS.map(({ tier, label }) => {
            const models = modelsFor(tier);
            if (models.length === 0) return null;
            const isOpen = expanded[tier];
            return (
              <div key={tier}>
                <button
                  onClick={() => toggleTier(tier)}
                  className="w-full flex items-center gap-1.5 text-left"
                >
                  <svg className={`w-3 h-3 text-fg-muted transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">{label}</span>
                </button>
                {isOpen && (
                  <div className="space-y-2 mt-2">
                    {models.map((m) => (
                      <RecommendedCard
                        key={m.id}
                        model={m}
                        card={cards[m.hfRepo]}
                        downloads={downloads}
                        quantOptsByKeyRef={quantOptsByKeyRef}
                        onRetry={() => void onEnsureQuants(m, true)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecommendedCard({
  model, card, downloads, quantOptsByKeyRef, onRetry,
}: {
  model: CuratedModel;
  card: CardState | undefined;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  onRetry: () => void;
}) {
  const chosenQuant = card?.state === 'ready' ? card.chosen.quant : model.quantDefault;
  const dl = activeDownload(downloads, model.hfRepo, chosenQuant);

  const startDownload = async () => {
    // download() takes the QuantOption OBJECT — prefer the resolved one, else
    // the stashed default-quant option.
    const opt = card?.state === 'ready' ? card.chosen : quantOptsByKeyRef.current[key(model.hfRepo, model.quantDefault)];
    if (!opt) return; // still resolving — button is disabled in this state anyway
    await window.claude.models.download(model.hfRepo, opt);
  };

  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg font-medium truncate">{model.label}</p>
          {model.notes && <p className="text-[10px] text-fg-muted">{model.notes}</p>}
          {/* Lazy size + fit line. */}
          {(!card || card.state === 'loading') && (
            <p className="text-[10px] text-fg-muted mt-0.5">Checking size…</p>
          )}
          {card?.state === 'ready' && (
            <p className="text-[10px] mt-0.5">
              <span className="text-fg-dim">{gb(card.chosen.totalSizeBytes)} · {card.chosen.quant}</span>
              {' · '}
              <span className={fitColor(card.chosen.fit.fit)}>{card.chosen.fit.label}</span>
            </p>
          )}
          {card?.state === 'unavailable' && (
            <button onClick={onRetry} className="text-[10px] text-amber-500 mt-0.5 hover:underline text-left">
              Couldn't reach Hugging Face for this model — tap to retry
            </button>
          )}
        </div>
        {!dl && (
          <button
            onClick={() => void startDownload()}
            disabled={card?.state !== 'ready'}
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
          >
            Download
          </button>
        )}
      </div>
      {dl && <DownloadProgressRow dl={dl} />}
    </div>
  );
}

// ── 3. Installed models ──────────────────────────────────────────────────────

function InstalledModels({
  installed, downloads, quantOptsByKeyRef, onRefresh, setDownloads,
}: {
  installed: InstalledLocalModel[] | null;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
  onRefresh: () => Promise<void>;
  setDownloads: React.Dispatch<React.SetStateAction<Record<string, DownloadProgress>>>;
}) {
  // In-progress / partial downloads (anything not 'done'): shown with Resume /
  // Discard so a cancelled or crashed download isn't stranded on disk.
  const partials = Object.values(downloads).filter((d) => d.state !== 'done');

  return (
    <div className="rounded-lg border border-edge-dim bg-well px-3 py-2.5">
      <p className="text-xs text-fg font-medium mb-2">Installed models</p>

      {installed === null ? (
        <p className="text-[11px] text-fg-muted px-1">Loading…</p>
      ) : installed.length === 0 && partials.length === 0 ? (
        <p className="text-[11px] text-fg-muted px-1">No models downloaded yet.</p>
      ) : (
        <div className="space-y-2">
          {installed?.map((m) => (
            <InstalledRow key={m.id} model={m} onRefresh={onRefresh} />
          ))}
          {partials.map((dl) => (
            <PartialRow
              key={dl.downloadId}
              dl={dl}
              quantOptsByKeyRef={quantOptsByKeyRef}
              onRefresh={onRefresh}
              setDownloads={setDownloads}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InstalledRow({ model, onRefresh }: { model: InstalledLocalModel; onRefresh: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const doDelete = async () => {
    setBusy(true);
    try {
      await window.claude.models.delete(model.id);
      setConfirming(false);
      await onRefresh();
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
          <button
            onClick={() => setConfirming(true)}
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
          >
            Delete
          </button>
        )}
      </div>

      {/* Consequence-gated delete — plain-language warning before the file is removed. */}
      {confirming && (
        <div className="mt-2 space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
          <p className="text-[11px] text-fg-dim leading-relaxed">
            This removes the model file ({gb(model.sizeBytes)}) from this computer. Re-downloading it later will take a while.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setConfirming(false)}
              className="flex-1 text-xs font-medium py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
            >
              Keep
            </button>
            <button
              onClick={() => void doDelete()}
              disabled={busy}
              className="flex-1 text-xs font-medium py-2 rounded-lg bg-red-500 text-white hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Deleting…' : 'Delete model'}
            </button>
          </div>
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
          <button
            onClick={() => void resume()}
            disabled={busy}
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors disabled:opacity-60"
          >
            Resume
          </button>
          <button
            onClick={() => void discard()}
            disabled={busy}
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-60"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 4. Add from Hugging Face ─────────────────────────────────────────────────

function HuggingFaceSearch({
  downloads, quantOptsByKeyRef,
}: {
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<HFSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    setExpandedRepo(null);
    try {
      setHits(await window.claude.models.search(q) as HFSearchHit[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="rounded-lg border border-edge-dim bg-well px-3 py-2.5">
      <p className="text-xs text-fg font-medium mb-2">Add from Hugging Face</p>

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
          placeholder="Search GGUF models (e.g. qwen)"
          aria-label="Search Hugging Face models"
          className="flex-1 text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
        />
        <button
          onClick={() => void runSearch()}
          disabled={searching || query.trim().length === 0}
          className="text-xs font-medium px-3 py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <p className="text-[10px] text-red-500 mt-2">{error}</p>}

      {hits !== null && !error && (
        hits.length === 0 ? (
          <p className="text-[11px] text-fg-muted mt-2 px-1">No models found.</p>
        ) : (
          <div className="space-y-2 mt-2">
            {hits.map((hit) => (
              <SearchHit
                key={hit.repo}
                hit={hit}
                expanded={expandedRepo === hit.repo}
                onToggle={() => setExpandedRepo((cur) => (cur === hit.repo ? null : hit.repo))}
                downloads={downloads}
                quantOptsByKeyRef={quantOptsByKeyRef}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function SearchHit({
  hit, expanded, onToggle, downloads, quantOptsByKeyRef,
}: {
  hit: HFSearchHit;
  expanded: boolean;
  onToggle: () => void;
  downloads: Record<string, DownloadProgress>;
  quantOptsByKeyRef: React.MutableRefObject<Record<string, QuantWithFit>>;
}) {
  const [quants, setQuants] = useState<QuantWithFit[] | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [showAll, setShowAll] = useState(false);

  const loadQuants = useCallback(async () => {
    setLoadState('loading');
    try {
      const opts = await window.claude.models.quants(hit.repo) as QuantWithFit[];
      for (const o of opts) quantOptsByKeyRef.current[key(hit.repo, o.quant)] = o;
      setQuants(opts);
      setLoadState('idle');
    } catch {
      setLoadState('error');
    }
  }, [hit.repo, quantOptsByKeyRef]);

  // Fetch quants the first time the hit is expanded.
  useEffect(() => {
    if (expanded && quants === null && loadState === 'idle') void loadQuants();
  }, [expanded, quants, loadState, loadQuants]);

  // Recommended quants first; the rest hide behind "Show all N".
  const recommended = (quants ?? []).filter((q) => RECOMMENDED_QUANTS.has(q.quant));
  const rest = (quants ?? []).filter((q) => !RECOMMENDED_QUANTS.has(q.quant));
  const visible = showAll ? [...recommended, ...rest] : (recommended.length > 0 ? recommended : (quants ?? []).slice(0, 3));
  const hiddenCount = (quants ?? []).length - visible.length;

  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      <button onClick={onToggle} className="w-full flex items-center gap-2 text-left">
        <svg className={`w-3 h-3 text-fg-muted transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg font-medium truncate">{hit.repo}</p>
          <p className="text-[10px] text-fg-muted">{hit.downloads.toLocaleString()} downloads</p>
        </div>
      </button>

      {expanded && (
        <div className="mt-2">
          {loadState === 'loading' && <p className="text-[10px] text-fg-muted px-1">Loading versions…</p>}
          {loadState === 'error' && (
            <button onClick={() => void loadQuants()} className="text-[10px] text-amber-500 hover:underline px-1">
              Couldn't reach Hugging Face — tap to retry
            </button>
          )}
          {quants !== null && loadState !== 'loading' && (
            <div className="space-y-1.5">
              {visible.map((q) => (
                <QuantDownloadRow key={q.quant} repo={hit.repo} q={q} downloads={downloads} />
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

function QuantDownloadRow({ repo, q, downloads }: { repo: string; q: QuantWithFit; downloads: Record<string, DownloadProgress> }) {
  const dl = activeDownload(downloads, repo, q.quant);
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
          <button
            onClick={() => void window.claude.models.download(repo, q)}
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all shrink-0"
          >
            Download
          </button>
        )}
      </div>
      {dl && <DownloadProgressRow dl={dl} />}
    </div>
  );
}

// ── 5. Other local apps ──────────────────────────────────────────────────────

const APP_NAME: Record<DetectedEndpoint['kind'], string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

function OtherLocalApps() {
  const [hits, setHits] = useState<DetectedEndpoint[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [added, setAdded] = useState<Record<string, boolean>>({});

  const detect = async () => {
    setDetecting(true);
    try { setHits(await window.claude.models.detectEndpoints() as DetectedEndpoint[]); }
    catch { setHits([]); }
    finally { setDetecting(false); }
  };

  const addEndpoint = async (hit: DetectedEndpoint) => {
    // Register the detected server as an openai-compatible provider — the user
    // then manages it in the Providers section above.
    await window.claude.providers.upsert({
      type: 'openai-compatible',
      label: hit.label,
      baseUrl: hit.baseUrl,
      enabled: true,
    });
    setAdded((prev) => ({ ...prev, [hit.baseUrl]: true }));
  };

  return (
    <div className="rounded-lg border border-edge-dim bg-well px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg font-medium">Other local apps</p>
        <button
          onClick={() => void detect()}
          disabled={detecting}
          className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors disabled:opacity-60 shrink-0"
        >
          {detecting ? 'Detecting…' : 'Detect'}
        </button>
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
                    </div>
                    {!isAdded && (
                      <button
                        onClick={() => void addEndpoint(hit)}
                        className="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all shrink-0"
                      >
                        Add as endpoint
                      </button>
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
