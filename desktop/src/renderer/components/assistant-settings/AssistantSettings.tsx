import React, { useEffect, useMemo, useState } from 'react';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { useScrollFade } from '../../hooks/useScrollFade';
import SettingsExplainer, { InfoIconButton } from '../SettingsExplainer';
import { AnchorTip, Dialog, SettingRow } from '../ui';
import { PAGES, startSummary, type AssistantDefaults, type DefaultsUpdate, type PageDef, type PageId } from './pages';

// Settings → Assistant settings. ONE row that replaces four popups — Model
// Providers, Session Defaults, Permissions, Specialists — with one wide window:
// a list of pages down the left, the chosen page on the right (questions deck
// 2026-09-05, Q-1a). Provider-first, no search box, no invented settings — the
// concept Destin approved on 2026-09-04 when the earlier mockup was rejected.
//
// Phone width (Q-1a's fold): the page list is the first screen, a page opens
// with the dialog's back arrow — the shape of phone settings everywhere.
//
// Android (Q-6b): the same row and panel, showing only the pages the phone can
// serve today (General); the others arrive as the native runtime does.

export interface AssistantSettingsRowProps {
  defaults: AssistantDefaults;
  onDefaultsChange: (updates: DefaultsUpdate) => void;
  cwd?: string;
  onOpenClaudePreferences?: () => void;
  /** Deep link (the chat's provider-error bubble, the picker's "Manage
   *  models…"): open the panel on mount, on `autoOpenPage`, then clear the flag. */
  autoOpen?: boolean;
  autoOpenPage?: PageId;
  onAutoOpenHandled?: () => void;
  /** Q-6b: Android mounts the same row; `pages` says which pages exist there. */
  platform?: 'desktop' | 'android';
}

/** Which providers need attention right now (Q-4a: a warning dot on the row and
 *  on the page). ONLY states that are actually broken — a dot for anything less
 *  is the one way this row loses trust. Today: a ChatGPT plan OpenAI has blocked,
 *  and a local engine that failed to start. A key OpenRouter rejects is not
 *  known until a send fails; that error lands in the chat, not here. */
function useAttention(active: boolean): Set<PageId> {
  const [pages, setPages] = useState<Set<PageId>>(() => new Set());
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const next = new Set<PageId>();
    const chatgpt = (window as any).claude?.chatgpt;
    const engine = (window as any).claude?.engine;
    Promise.all([
      chatgpt?.status?.().then((s: { state?: string }) => { if (s?.state === 'blocked') next.add('chatgpt'); }).catch(() => {}),
      engine?.status?.().then((s: { state?: string; error?: string }) => { if (s?.state === 'error' || s?.error) next.add('local'); }).catch(() => {}),
    ]).then(() => { if (alive) setPages(next); });
    return () => { alive = false; };
  }, [active]);
  return pages;
}

const AttentionDot = ({ label }: { label: string }) => (
  <span
    className="inline-block w-2 h-2 rounded-full bg-destructive-fg shrink-0"
    role="img"
    aria-label={label}
    title={label}
  />
);

export default function AssistantSettingsRow({
  defaults,
  onDefaultsChange,
  cwd,
  onOpenClaudePreferences,
  autoOpen,
  autoOpenPage,
  onAutoOpenHandled,
  platform = 'desktop',
}: AssistantSettingsRowProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PageId>('general');
  // Phone fold: `null` page means "showing the list".
  const [narrowPage, setNarrowPage] = useState<PageId | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const narrow = useNarrowViewport();

  // The same gate the Model Providers row had: provider pages exist only where
  // the native runtime does (false over remote access, false on Android).
  const nativeSupported = (window as any).claude?.native?.supported === true;
  const pages = useMemo(
    () => PAGES.filter((p) => (platform === 'android' ? p.id === 'general' : !p.needsNative || nativeSupported)),
    [platform, nativeSupported],
  );

  useEffect(() => {
    if (autoOpen && !open) {
      const target = autoOpenPage && pages.some((p) => p.id === autoOpenPage) ? autoOpenPage : 'general';
      setPage(target);
      setNarrowPage(target);
      setOpen(true);
      onAutoOpenHandled?.();
    }
  }, [autoOpen, autoOpenPage, open, pages, onAutoOpenHandled]);

  // Reset the explainer on every re-open so the user always lands on the page.
  useEffect(() => { if (!open) { setShowInfo(false); setNarrowPage(null); } }, [open]);

  const attention = useAttention(true);
  const current: PageDef = pages.find((p) => p.id === (narrow ? narrowPage : page)) ?? pages[0];
  const showingList = narrow && narrowPage === null;

  const goTo = (id: PageId) => { setPage(id); setNarrowPage(id); setShowInfo(false); };
  const ctx = {
    defaults,
    onDefaultsChange,
    cwd,
    onOpenClaudePreferences,
    onClosePanel: () => setOpen(false),
    goTo,
  };

  const rowSummary = startSummary(defaults);

  // Dialog chrome depends on where we are: the list (phone), a page, or a
  // page's explainer. The back arrow appears only when the dialog navigated
  // within itself (G-10).
  const title = showInfo ? `About ${current.label}` : narrow && !showingList ? current.label : 'Assistant settings';
  const onBack = showInfo ? () => setShowInfo(false) : narrow && !showingList ? () => setNarrowPage(null) : undefined;

  return (
    <>
      <SettingRow
        // Stacked layers — the Model Providers glyph, kept: it is the row most
        // people knew, and "choose your engine" is still the first job here.
        icon={
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l9 5-9 5-9-5 9-5z" />
            <path d="M3 13l9 5 9-5" />
          </svg>
        }
        title="Assistant settings"
        // Q-4a: the live default, so the drawer answers "what will a new chat
        // use" without opening anything.
        description={rowSummary}
        accessory={attention.size > 0 ? <AttentionDot label="A provider needs attention" /> : undefined}
        onClick={() => setOpen(true)}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        onBack={onBack}
        // UX review 1 (U26): one place for every page's (i) — beside the page
        // title, where the short-tip pages already had theirs. On the phone the
        // page title IS the dialog header, so the (i) stays up there.
        headerActions={narrow && !showInfo && current.explainer && !showingList ? <InfoIconButton onClick={() => setShowInfo(true)} /> : undefined}
        size={narrow ? 'panel' : 'wide'}
        fill
        // The panel owns its two regions (static list, scrolling page), so the
        // shared single scroll body is switched off — and the page region below
        // takes the same scroll-fade the shared body would have had (G-11:
        // nothing is ever clipped silently).
        scrollBody={false}
      >
        {showInfo ? (
          <ExplainerBody intro={current.explainer!.intro} sections={current.explainer!.sections} />
        ) : narrow ? (
          showingList ? (
            <PageList pages={pages} attention={attention} onPick={(id) => setNarrowPage(id)} />
          ) : (
            <PageBody page={current} ctx={ctx} attention={attention} narrow />
          )
        ) : (
          <div className="flex flex-1 min-h-0">
            <PageRail pages={pages} current={page} attention={attention} onPick={goTo} />
            <PageBody page={current} ctx={ctx} attention={attention} onInfo={current.explainer ? () => setShowInfo(true) : undefined} />
          </div>
        )}
      </Dialog>
    </>
  );
}

// ── The list down the left (wide) ────────────────────────────────────────────

function PageRail({ pages, current, attention, onPick }: {
  pages: PageDef[];
  current: PageId;
  attention: Set<PageId>;
  onPick: (id: PageId) => void;
}) {
  // Rows are the menu row shape (G-21: icon · label, text-xs, short rows), not
  // SettingRows — a SettingRow's chevron says "this opens something", and a
  // page in this list is a place you are, not a place you go.
  let lastGroup: PageDef['group'] = null;
  return (
    <nav aria-label="Assistant settings pages" className="w-44 shrink-0 border-r border-edge px-2 py-3 space-y-0.5 overflow-y-auto">
      {pages.map((p) => {
        const eyebrow = p.group && p.group !== lastGroup ? p.group : null;
        lastGroup = p.group;
        const selected = p.id === current;
        return (
          <React.Fragment key={p.id}>
            {eyebrow && (
              <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase px-2 pt-3 pb-1">{eyebrow}</h3>
            )}
            <button
              type="button"
              onClick={() => onPick(p.id)}
              aria-current={selected ? 'page' : undefined}
              className={`w-full flex items-center gap-2 px-2 h-8 rounded-md text-xs text-left transition-colors ${
                selected ? 'bg-inset text-fg font-medium' : 'text-fg-muted hover:bg-inset/60 hover:text-fg'
              }`}
            >
              <span className="shrink-0 flex items-center">{p.icon}</span>
              <span className="flex-1 min-w-0 truncate">{p.label}</span>
              {attention.has(p.id) && <AttentionDot label={`${p.label} needs attention`} />}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

// ── The list as the first screen (phone) ─────────────────────────────────────

function PageList({ pages, attention, onPick }: {
  pages: PageDef[];
  attention: Set<PageId>;
  onPick: (id: PageId) => void;
}) {
  const ref = useScrollFade<HTMLDivElement>();
  return (
    <div ref={ref} className="scroll-fade flex-1">
      <div className="px-4 py-4 space-y-2">
        {pages.map((p) => (
          <SettingRow
            key={p.id}
            icon={<span className="text-fg-muted">{p.icon}</span>}
            title={p.label}
            accessory={attention.has(p.id) ? <AttentionDot label={`${p.label} needs attention`} /> : undefined}
            onClick={() => onPick(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ── One page ─────────────────────────────────────────────────────────────────

function PageBody({ page, ctx, attention, narrow, onInfo }: {
  page: PageDef;
  ctx: Parameters<PageDef['render']>[0];
  attention: Set<PageId>;
  narrow?: boolean;
  /** Opens the page's full explainer (Permissions, Specialists) — the (i)
   *  sits beside the title like the short tips do (U26). */
  onInfo?: () => void;
}) {
  const ref = useScrollFade<HTMLDivElement>();
  return (
    <div ref={ref} className="scroll-fade flex-1 min-w-0">
      <div className="px-4 py-4 space-y-4">
        {/* On the phone the dialog title already names the page. */}
        {!narrow && (
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-medium text-fg">{page.label}</h3>
            {page.info && <AnchorTip label={page.info.label} title={page.label}>{page.info.body}</AnchorTip>}
            {onInfo && <InfoIconButton onClick={onInfo} />}
            {attention.has(page.id) && <AttentionDot label={`${page.label} needs attention`} />}
          </div>
        )}
        {page.render(ctx)}
      </div>
    </div>
  );
}

function ExplainerBody({ intro, sections }: { intro: string; sections: NonNullable<PageDef['explainer']>['sections'] }) {
  const ref = useScrollFade<HTMLDivElement>();
  return (
    <div ref={ref} className="scroll-fade flex-1">
      {/* space-y-5: the explainer renders bare sections and relies on the
          dialog body's track for its rhythm; this track stands in for it. */}
      <div className="px-4 py-4 space-y-5">
        <SettingsExplainer intro={intro} sections={sections} />
      </div>
    </div>
  );
}
