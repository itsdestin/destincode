import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../state/theme-context';
import { useMarketplace } from '../state/marketplace-context';
import FavoriteStar from './marketplace/FavoriteStar';
import { computeOnAccent } from '../themes/theme-validator';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import type { LoadedTheme } from '../themes/theme-types';
import { useEscClose } from '../hooks/use-esc-close';
import { Button, Select, Toggle, SettingRow } from './ui';

// Plain-language explainer for the Appearance popup. Shown when the user taps
// the (i) icon in the popup header — see ThemeScreen's `showInfo` state.
const APPEARANCE_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Appearance lets you customize how YouCoded looks — colors, fonts, animations, and visual effects. You can use a built-in theme, download one from the marketplace, or build your own just by describing it to Claude.",
  sections: [
    {
      heading: "What's a theme?",
      paragraphs: [
        "A theme is a set of colors and styles that change the whole look of the app. It includes the background, text colors, accent color (used for buttons and highlights), how round the corners are, and decorative effects like falling particles or blurred glass panels.",
      ],
    },
    {
      heading: 'What the settings do',
      bullets: [
        { term: 'Your Themes', text: 'Every theme installed on your device. Tap one to use it right away.' },
        { term: 'The pencil icon', text: 'Opens an edit menu for that theme. For themes you built yourself, you can change the accent color, roundness, and particles. For any theme with a wallpaper, you can also tune the glass (blur/opacity) here. Built-in themes are otherwise locked — make a copy via "Build New Theme with Claude" if you want to change more.' },
        { term: 'Theme cycle', text: 'Configured from the status bar widget editor (tap the gear in the status bar → the pencil next to "Theme"). Themes in the cycle rotate when you tap the theme pill at the bottom.' },
        { term: 'Reduce Visual Effects', text: 'Turns off particles, glass blur, and animations. Use this if the app feels slow or if movement bothers you. Glass blur sliders are automatically disabled while this is on.' },
        { term: 'Message Timestamps', text: 'Shows the time each chat message was sent inside the bubble.' },
        { term: 'Browse Theme Marketplace', text: 'Open the gallery of themes other people have made and shared. Free to install.' },
        { term: 'Build New Theme with Claude', text: "Asks Claude to create a brand-new theme just by describing what you want in plain English (e.g. 'a soft sage green theme with rounded corners')." },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: 'Theme looks broken or colors are missing', text: "The theme file may be corrupted. Switch back to a built-in theme (Light/Dark/Midnight/Crème) first, then try the broken one again." },
        { term: 'App feels slow or laggy', text: 'Turn on "Reduce Visual Effects". Particles and glass blur use the most power — disabling them usually fixes it instantly.' },
        { term: "Can't edit most of a theme", text: "Only themes you made yourself can have their accent/roundness/particles changed. Built-in themes are read-only aside from glass tuning. Tap 'Build New Theme with Claude' to make your own copy." },
        { term: "Theme cycle isn't switching", text: 'Open the status bar widget editor and use the pencil next to "Theme" to pick at least 2 themes for the cycle.' },
        { term: 'Custom font not showing', text: "YouCoded reads fonts installed on your computer. If the font you want isn't installed system-wide, it can't be selected here. Install it through your operating system first." },
        { term: 'Published theme not appearing in marketplace', text: 'Theme submissions are reviewed before they go live. Yours should appear within a day or two if it passes the safety checks.' },
      ],
    },
  ],
};

const PARTICLE_OPTIONS = ['none', 'rain', 'dust', 'ember', 'snow', 'custom'] as const;

// Shape PARTICLE_OPTIONS for the shared <Select> (change 21). Labels stay the
// raw preset names so the visible text is unchanged from the old <option> list.
const PARTICLE_SELECT_OPTIONS = PARTICLE_OPTIONS.map((p) => ({ value: p, label: p }));

function roundnessToShape(value: number) {
  const sm  = Math.round(value * 8);
  const md  = Math.round(value * 16);
  const lg  = Math.round(value * 24);
  const xl  = Math.round(value * 32);
  const xxl = Math.min(Math.round(value * 48), 36); // cap at 36px to prevent bubble content clipping
  return { 'radius-sm': `${sm}px`, 'radius-md': `${md}px`, 'radius-lg': `${lg}px`, 'radius-xl': `${xl}px`, 'radius-2xl': `${xxl}px`, 'radius-full': '9999px' };
}

interface Props {
  onClose: () => void;
  onSendInput?: (text: string) => void;
  /** Run a slash command through the dispatcher rather than piping raw text at a
   *  PTY. Native sessions have no PTY, so onSendInput silently did nothing there
   *  — this button was fully dead in a YouCoded-runtime session (handoff §2.3,
   *  "the single most visible instance of the gap M3 closes"). */
  onRunCommand?: (command: string) => void;
  onOpenMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  /**
   * K12: `showInfo` is LIFTED to the Dialog owner rather than held here.
   *
   * This component fills a Dialog it does not own, so it cannot reach the
   * shell's header to set the explainer's title and back chevron. The host
   * holds the boolean, sets `title`/`onBack`/`scrollBody` from it, and passes
   * it back down — which is what lets the explainer drop its hand-rolled
   * header instead of reimplementing the one D1 already owns.
   */
  showInfo: boolean;
  onShowInfo: (next: boolean) => void;
  /**
   * Lifted for the same reason as `showInfo`: the Dialog's header has to name
   * the theme being edited and offer the way back, and this component cannot
   * reach a Dialog it does not own.
   */
  editingSlug: string | null;
  onEditSlug: (slug: string | null) => void;
}

// Small pencil icon used on theme cards to open the per-theme edit panel.
const PencilIcon = ({ className = 'w-3 h-3' }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

export default function ThemeScreen({ onClose, onSendInput, onRunCommand, onOpenMarketplace, onPublishTheme, showInfo, onShowInfo, editingSlug, onEditSlug }: Props) {
  // Always mounted when open (parent conditionally renders) — so open=true is correct here.
  useEscClose(true, onClose);
  const { allThemes, activeTheme, theme: activeSlug, setTheme, reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps, setGlassOverride } = useTheme();
  // MarketplaceContext supplies favorites and the toggle action.
  const mp = useMarketplace();
  const themeFavSet = useMemo(() => new Set(mp.themeFavorites), [mp.themeFavorites]);

  // Appearance panel shows favorites only, plus the active theme as a fallback
  // so there's always at least one card even when the user has unstarred their
  // current theme. "Browse all themes" is the escape hatch for the full list.
  const gridThemes = useMemo(() => {
    const favs = allThemes.filter(t => themeFavSet.has(t.slug));
    if (favs.some(t => t.slug === activeSlug)) return favs;
    const active = allThemes.find(t => t.slug === activeSlug);
    return active ? [...favs, active] : favs;
  }, [allThemes, themeFavSet, activeSlug]);

  // Slug of the theme currently being edited (pencil opened). Null = main list.

  // Open edit view for a theme. We also activate it so edits preview live
  // behind the popup — users expect to see changes as they drag sliders.
  const openEditor = (slug: string) => {
    if (slug !== activeSlug) setTheme(slug);
    onEditSlug(slug);
  };

  // Fix: read from activeTheme (which has glassOverrides merged) rather than
  // raw allThemes, otherwise the Panel/Bubble Blur + Opacity sliders read a
  // stale base value and the thumb appears frozen while overrides still
  // persist + apply to the DOM. openEditor() always activates the theme being
  // edited, so activeSlug === editingSlug here. Fall back to the raw lookup
  // if they ever diverge (e.g. race with a concurrent setTheme).
  const editingTheme = editingSlug
    ? (editingSlug === activeSlug ? activeTheme : allThemes.find(t => t.slug === editingSlug) ?? null)
    : null;

  if (showInfo) {
    // Header + scroll body come from the Dialog above this component now.
    return <SettingsExplainer intro={APPEARANCE_EXPLAINER.intro} sections={APPEARANCE_EXPLAINER.sections} />;
  }

  if (editingTheme) {
    return (
      <ThemeEditView
        theme={editingTheme}
        reducedEffects={reducedEffects}
        setGlassOverride={setGlassOverride}
        onPublishTheme={onPublishTheme}
        onClose={onClose}
      />
    );
  }

  return (
    // D1: header, close and scroll body come from the Dialog. The body keeps
    // space-y-4 rather than the shell's space-y-5 — the theme grid is dense on
    // purpose — but takes the shell's px-4 py-4 in place of its own p-3.
    <div className="space-y-4">
        {/* Theme grid — pencil on each card opens the per-theme edit view.
            Cycle membership moved to the status bar widget editor. */}
        <div>
          <p className="text-4xs text-fg-muted uppercase tracking-wider mb-2">Your Themes</p>
          <div className="grid grid-cols-2 gap-2">
            {gridThemes.map(t => {
              const isActive = t.slug === activeSlug;
              const isFav = themeFavSet.has(t.slug);
              return (
                // Fix: outer element is div+role=button (not <button>) so the
                // nested pencil and star buttons are valid HTML (no button-in-button).
                <div
                  key={t.slug}
                  role="button"
                  tabIndex={0}
                  onClick={() => setTheme(t.slug)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTheme(t.slug); } }}
                  // Change 22 reaches these tiles ONLY as a focus ring. They are
                  // deliberately NOT .layer-surface: the tile paints the
                  // *previewed* theme's own tokens inline, so painting the
                  // active theme's panel over it would defeat the preview.
                  // They were the only keyboard-reachable control in this file
                  // with no focus indication at all.
                  className={`relative rounded-lg overflow-hidden border text-left transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isActive ? 'border-accent' : 'border-edge-dim hover:border-edge'}`}
                >
                  <div style={{ height: 6, background: `linear-gradient(90deg, ${t.tokens.canvas}, ${t.tokens.accent})` }} />
                  <div className="px-2 py-1.5" style={{ background: t.tokens.canvas }}>
                    {/* Leave room on right for the pencil and star icons */}
                    <p className="text-3xs font-medium truncate pr-8" style={{ color: t.tokens.fg }}>{t.name}</p>
                    {isActive && <span className="text-4xs" style={{ color: t.tokens.accent }}>active</span>}
                  </div>
                  {/* Pencil — opens the per-theme edit menu. Positioned bottom-right
                      to avoid overlap with the star which occupies top-right. */}
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); openEditor(t.slug); }}
                    // Change 41: retires the app's last raw `hover:bg-black/20`.
                    // The obvious swap — the ghost Button's hover:bg-inset — would
                    // be WRONG here: this button floats on a swatch painted in the
                    // PREVIEWED theme's colours, so an app-theme hover fill can land
                    // invisible (or garish) on any given swatch. `bg-current` resolves
                    // to the inline `color` below, i.e. that theme's own fg, so the
                    // hover is legible on a light and a dark swatch alike. 20% black
                    // could not do that — it vanished on dark themes.
                    className="absolute bottom-1 right-1 w-5 h-5 rounded-sm flex items-center justify-center hover:bg-current/15 coarse-hit transition-colors"
                    style={{ color: t.tokens.fg }}
                    title="Edit theme"
                    aria-label={`Edit ${t.name}`}
                  >
                    <PencilIcon />
                  </button>
                  {/* Star — toggles this theme in/out of the Appearance panel favorites. */}
                  <FavoriteStar
                    filled={isFav}
                    onToggle={() => mp.favoriteTheme(t.slug, !isFav).catch(() => {})}
                    size="sm"
                    corner
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Browse all themes — dispatches a global event that App.tsx listens
            for to open the Library on the themes tab and close this popup. */}
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('youcoded:open-library', { detail: { tab: 'themes' } }));
          }}
          className="layer-surface w-full mt-1 px-4 py-3 text-fg-2 hover:text-fg text-sm flex items-center justify-center gap-2"
        >
          Browse all themes →
        </button>

        {/* Build with Claude — surfaced directly below the grid so users see
            the "make a new one" affordance before the ancillary toggles.
            Follow-up will relocate to the popup header and launch in a new
            session instead of piping into the current one.

            Now a filled `primary` (spec change 63). It used to be an accent-tinted
            OUTLINE (border-accent/30 + bg-accent/10 + text-accent) — a 5th button
            style that the shared Button doesn't have and that we don't want to add.
            Filling it keeps Build visually stronger than Browse (secondary) below,
            which is the hierarchy the tinted outline was there to create. */}
        <Button
          onClick={() => {
            // Per Q5 (Destin, 2026-07-28): run in the CURRENT session, not a new
            // one. onRunCommand routes through the slash dispatcher, which knows
            // how to reach a native session's harness; onSendInput is the legacy
            // raw-PTY path and is kept only as a fallback for callers that have
            // not been rewired.
            if (onRunCommand) onRunCommand('/theme-builder');
            else onSendInput?.('/theme-builder ');
            onClose();
          }}
          className="w-full py-2"
        >
          ✦ Build New Theme with Claude
        </Button>

        {/* Browse marketplace — paired with Build as the two acquisition paths */}
        {onOpenMarketplace && (
          <Button
            variant="secondary"
            onClick={() => {
              onOpenMarketplace();
              onClose();
            }}
            className="w-full py-2"
          >
            Browse Theme Marketplace
          </Button>
        )}

        {/* Reduce Visual Effects — always on the main screen (accessibility/perf toggle).
            Global: disables particles, forces blur to 0, shortens animations. Previously
            this was nested inside the wallpaper-only Glass section, hiding it from users
            on solid/gradient themes who also benefit from the accessibility setting. */}
        <SettingRow
          variant="item"
          title="Reduce Visual Effects"
          description="Disables particles, blur, and animations"
          control={
            // Was a hand-rolled 36x20 switch (change 15): same geometry, but the
            // shared Toggle also carries role="switch" + aria-checked, which this
            // one never had — a screen reader read it as an unlabelled button.
            <Toggle
              checked={reducedEffects}
              onChange={(next) => setReducedEffects(next)}
              aria-label="Reduce Visual Effects"
            />
          }
        />

        {/* Message timestamps toggle */}
        <SettingRow
          variant="item"
          title="Message Timestamps"
          description="Show time sent in each chat bubble"
          // Same migration as the toggle above (change 15).
          control={
            <Toggle
              checked={showTimestamps}
              onChange={(next) => setShowTimestamps(next)}
              aria-label="Message Timestamps"
            />
          }
        />
    </div>
  );
}

// Per-theme edit view — opened via the pencil on a theme card.
// - User themes: accent / roundness / particles / publish, plus glass if wallpaper
// - Built-in or community themes: glass only (accent/roundness/particles are locked)
interface EditProps {
  theme: LoadedTheme;
  reducedEffects: boolean;
  setGlassOverride: (slug: string, field: string, v: number) => void;
  onPublishTheme?: (slug: string) => void;
  /** Closes the popup after publishing. An ACTION, not header chrome. */
  onClose: () => void;
}

// D1: the "Edit: {name}" title and the back chevron are the Dialog's, driven by
// the same `editingSlug` that selects this view. Its own header reimplemented
// the back arrow as a bare "←" glyph at a third size.
function ThemeEditView({ theme, reducedEffects, setGlassOverride, onPublishTheme, onClose }: EditProps) {
  const accentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserTheme = theme.source === 'user';
  // Community themes are downloaded from the marketplace. They share the
  // non-user edit surface (glass + terminal overrides only, preserved per-slug)
  // so upstream updates stay mergeable — but the banner copy must distinguish
  // them from the 4 built-in themes or users think marketplace downloads are
  // "built-in" and broken.
  const isCommunityTheme = theme.source === 'community';
  const hasWallpaper = theme.background?.type === 'image';
  const hasGradient = theme.background?.type === 'gradient';
  // Pre-baked terminal-value asset already has blur/brightness cooked in — the
  // runtime-filter slider wouldn't affect it, so hide those two sliders.
  const hasBakedTerminalBg = hasWallpaper && !!theme.background?.['terminal-value'];
  const canTuneTerminalOpacity = hasWallpaper || hasGradient;
  const canTuneTerminalFilter = hasWallpaper && !hasBakedTerminalBg;

  const updateAccent = useCallback((hex: string) => {
    if (!isUserTheme) return;
    if (accentTimerRef.current) clearTimeout(accentTimerRef.current);
    accentTimerRef.current = setTimeout(() => {
      const onAccent = computeOnAccent(hex);
      const updated = { ...theme, tokens: { ...theme.tokens, accent: hex, 'on-accent': onAccent } };
      (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
    }, 150);
  }, [theme, isUserTheme]);

  // Change 40 (§9.D): the roundness slider is CONTROLLED, but its source of
  // truth (currentRoundness, below) is derived from the theme FILE via an async
  // writeFile — it does not update within a drag. A bare `value={currentRoundness}`
  // would therefore freeze the thumb mid-drag. So we keep a local draft the drag
  // updates instantly, and re-sync it whenever currentRoundness changes for an
  // EXTERNAL reason (switching which theme is being edited) — the exact staleness
  // §9.D flagged. Same draft+resync shape as EngineCard's context knob.
  const [roundnessDraft, setRoundnessDraft] = useState(0.5);

  const updateRoundness = useCallback((value: number) => {
    if (!isUserTheme) return;
    const shape = roundnessToShape(value);
    const updated = { ...theme, shape };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  const updateParticles = useCallback((preset: string) => {
    if (!isUserTheme) return;
    const updated = { ...theme, effects: { ...(theme.effects ?? {}), particles: preset as any } };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  // Glass fields are writable for user themes (persisted to the theme file)
  // and overridable via localStorage for built-in/community themes.
  const updateBackground = useCallback((field: string, value: number) => {
    if (!isUserTheme) return;
    const updated = { ...theme, background: { ...(theme.background ?? { type: 'solid' as const, value: 'transparent' }), [field]: value } };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  const setGlassField = (field: string, v: number) => {
    if (isUserTheme) updateBackground(field, v);
    else setGlassOverride(theme.slug, field, v);
  };

  const currentRoundness = (() => {
    const md = theme.shape?.['radius-md'];
    if (!md) return 0.5;
    return Math.min(parseInt(md) / 16, 1);
  })();

  // Re-sync the draft when the underlying theme's roundness changes for a reason
  // other than this slider (e.g. the editor is pointed at a different theme).
  useEffect(() => { setRoundnessDraft(currentRoundness); }, [currentRoundness]);

  return (
    <div className="space-y-4">
        {/* Locked banner for non-user themes so it's clear why most controls are absent */}
        {!isUserTheme && (
          <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 leading-relaxed">
            {isCommunityTheme
              ? 'Marketplace themes are kept in sync with their author\u2019s updates. Glass + terminal transparency sliders are customizable per-theme. Use "Build New Theme with Claude" to fork an editable copy.'
              : 'Built-in themes are locked. Only glass + terminal transparency sliders are customizable. Use "Build New Theme with Claude" to make an editable copy.'}
          </p>
        )}

        {/* User-theme-only controls */}
        {isUserTheme && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-2">Accent</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={theme.tokens.accent}
                  onChange={e => updateAccent(e.target.value)}
                  className="w-6 h-6 rounded-sm cursor-pointer border-0 bg-transparent"
                />
                <span className="text-3xs text-fg-muted font-mono">{theme.tokens.accent}</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-fg-2">Roundness</span>
              <div className="flex items-center gap-2 flex-1">
                <span className="text-3xs text-fg-faint">□</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={roundnessDraft}
                  onChange={e => { const v = parseFloat(e.target.value); setRoundnessDraft(v); updateRoundness(v); }}
                  className="flex-1 accent-accent"
                />
                <span className="text-3xs text-fg-faint">◯</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-2">Particles</span>
              {/* Was a native <select> (change 21). A native select's option list is
                  drawn by the OS, so the open menu showed the OS blue-highlight
                  styling inside a themed app — styling the closed trigger alone
                  couldn't fix that. <Select> renders the list itself.
                  The width wrapper keeps the row's right-hand control from
                  stretching: the Select trigger is w-full by design. */}
              <div className="w-32 shrink-0">
                <Select
                  size="sm"
                  options={PARTICLE_SELECT_OPTIONS}
                  value={theme.effects?.particles ?? 'none'}
                  onChange={updateParticles}
                  aria-label="Particles"
                />
              </div>
            </div>
          </div>
        )}

        {/* Glass — themes with an image OR gradient background composite a real layer
            behind the chrome, so blurring/translucency produces a visible effect. Solid
            themes have nothing behind the chrome so the sliders are hidden. Blur sliders
            are greyed when Reduce Visual Effects is on (the engine forces blur:0). */}
        {(hasWallpaper || hasGradient) && (
          <div>
            <p className="text-4xs text-fg-muted uppercase tracking-wider mb-2">Glass</p>
            {reducedEffects && (
              <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                Reduce Visual Effects is active — blur is disabled. Opacity still applies.
              </p>
            )}
            <div className="space-y-3">
              <GlassSlider
                label="Panel Blur"
                min={0} max={30} step={1}
                value={theme.background?.['panels-blur'] ?? 24}
                disabled={reducedEffects}
                onChange={v => setGlassField('panels-blur', v)}
                format={v => String(Math.round(v))}
              />
              <GlassSlider
                label="Panel Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['panels-opacity'] ?? 0.88}
                onChange={v => setGlassField('panels-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
              <GlassSlider
                label="Bubble Blur"
                min={0} max={24} step={1}
                value={theme.background?.['bubble-blur'] ?? 16}
                disabled={reducedEffects}
                onChange={v => setGlassField('bubble-blur', v)}
                format={v => String(Math.round(v))}
              />
              <GlassSlider
                label="Bubble Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['bubble-opacity'] ?? 0.88}
                onChange={v => setGlassField('bubble-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
            </div>
          </div>
        )}

        {/* Terminal — transparency knobs for TerminalView. Opacity applies to
            any see-through background (wallpaper OR gradient). Blur + brightness
            are runtime-CSS-filter on the wallpaper layer, so they're hidden when
            the theme ships a pre-baked `terminal-value` asset (bake dictates
            those values) or when there's no wallpaper to blur. */}
        {canTuneTerminalOpacity && (
          <div>
            <p className="text-4xs text-fg-muted uppercase tracking-wider mb-2">Terminal</p>
            {canTuneTerminalFilter && reducedEffects && (
              <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                Reduce Visual Effects is active — wallpaper blur is disabled. Opacity + brightness still apply.
              </p>
            )}
            {hasBakedTerminalBg && (
              <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                This theme ships a pre-blurred terminal wallpaper — blur + brightness are baked in. Only opacity is adjustable here.
              </p>
            )}
            <div className="space-y-3">
              <GlassSlider
                label="Terminal Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['terminal-opacity'] ?? 0.6}
                onChange={v => setGlassField('terminal-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
              {canTuneTerminalFilter && (
                <>
                  <GlassSlider
                    label="Wallpaper Blur"
                    min={0} max={30} step={1}
                    value={theme.background?.['terminal-blur'] ?? 8}
                    disabled={reducedEffects}
                    onChange={v => setGlassField('terminal-blur', v)}
                    format={v => String(Math.round(v))}
                  />
                  <GlassSlider
                    label="Wallpaper Brightness"
                    min={0.5} max={1.2} step={0.02}
                    value={theme.background?.['terminal-brightness'] ?? 0.86}
                    onChange={v => setGlassField('terminal-brightness', v)}
                    format={v => `${Math.round(v * 100)}%`}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {/* Publish — user themes only */}
        {isUserTheme && onPublishTheme && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onPublishTheme(theme.slug);
              onClose();
            }}
            className="w-full"
          >
            Publish to Marketplace
          </Button>
        )}
    </div>
  );
}

// Single glass slider row — greys out when disabled and shows the formatted value.
function GlassSlider({
  label, min, max, step, value, onChange, format, disabled = false,
}: {
  label: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-xs text-fg-2 shrink-0">{label}</span>
      <div className="flex items-center gap-2 flex-1">
        <input
          type="range" min={min} max={max} step={step}
          value={value}
          disabled={disabled}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-3xs text-fg-muted w-9 text-right">{format(value)}</span>
      </div>
    </div>
  );
}
