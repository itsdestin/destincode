/**
 * Theme Contrast Rules — shared between Node and the browser.
 *
 * WHY this file exists: the Kit page validates palettes live in the browser as
 * the user drags color pickers, and check-contrast.cjs validates them at build
 * time in Node. Those two MUST agree — a palette that reads "passing" in the
 * editor and then fails the build gate is a bug report waiting to happen. So the
 * math and the RULES table live here exactly once, and both consumers import it.
 *
 * Dual export (module.exports for Node, window.themeContrast for the browser)
 * rather than a bundler — the rest of this skill is zero-dependency hand-rolled
 * JS and adding a build step just for one file isn't worth it.
 *
 * Three tiers:
 *   HARD    — UI breaks (text unreadable, elements invisible). Fails the build.
 *   SURFACE — Elements lose visual boundaries. Fails the build.
 *   SOFT    — Degraded but usable. Warns only.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.themeContrast = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Color math helpers ────────────────────────────────────────────────────

  /** Parse hex (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) to { r, g, b, a }, rgb 0-255, a 0-1 */
  function parseHex(hex) {
    if (!hex || typeof hex !== 'string') return null;
    hex = hex.replace(/^#/, '');
    // Strip alpha suffix if present (e.g. "#37373780") — edge-dim carries one.
    let a = 255;
    if (hex.length === 4) {
      // #RGBA
      a = parseInt(hex[3] + hex[3], 16);
      hex = hex.slice(0, 3);
    } else if (hex.length === 8) {
      // #RRGGBBAA
      a = parseInt(hex.slice(6, 8), 16);
      hex = hex.slice(0, 6);
    }
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length !== 6) return null;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: a / 255,
    };
  }

  /** WCAG relative luminance (0-1) from sRGB channel 0-255 */
  function luminance(rgb) {
    const [rs, gs, bs] = [rgb.r, rgb.g, rgb.b].map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /** WCAG contrast ratio between two luminances (returns >= 1) */
  function contrastRatio(l1, l2) {
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** Luminance ratio (non-WCAG, for surface distinction — just the raw ratio) */
  function luminanceRatio(l1, l2) {
    if (l1 === 0 && l2 === 0) return 1;
    const a = Math.max(l1, l2);
    const b = Math.min(l1, l2);
    // For very dark surfaces, use absolute difference check instead
    if (a < 0.01) return 1 + Math.abs(l1 - l2) * 100;
    return a / (b || 0.0001);
  }

  /**
   * Apply alpha to a foreground color over a background color.
   * Returns composited { r, g, b } with a=1.
   */
  function alphaComposite(fg, bg, alpha) {
    return {
      r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
      g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
      b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
      a: 1,
    };
  }

  // ── Rule definitions ──────────────────────────────────────────────────────

  /**
   * Each rule: { name, tier, threshold, type, fg, bg, [fgAlpha], description }
   *   type: "contrast" = WCAG contrast ratio, "distinction" = luminance ratio
   *   fg/bg: token names from manifest.tokens
   *   fgAlpha: optional multiplier on the fg color's opacity (for timestamp rules)
   */
  /**
   * TEXT RAMP TARGETS — the minimum contrast each text tier must reach against
   * EVERY surface it can land on. Kept identical to solve-ramp.js::TARGETS; the
   * solver places the ramp and these rules verify it, so if the two ever
   * disagree the builder would emit palettes its own gate rejects.
   *
   * WHY THIS REPLACED THE OLD HAND-WRITTEN TEXT RULES
   * -------------------------------------------------
   * The previous table had SIX text rules total. `fg-muted` appeared exactly
   * once ('fg-muted/60 on inset', SOFT, 2.0) and `fg-faint` appeared ZERO
   * times — so the builder's model of the app had three text tiers while the
   * app actually uses five, across ~466 places that render real content.
   * Nothing checked `well` as a text background at all, and nothing composited
   * glass. Measured 2026-07-19, that gap shipped:
   *   - `fg-muted` on a raised surface failed in 9 of 11 themes
   *   - `fg-faint` on a raised surface had NEVER passed in any shipped theme
   *   - composited over its real wallpaper, meadow-mist bottomed out at 1.01
   *     (identical luminance — literally invisible) while the flat-token audit
   *     reported 1.24 and CI stayed green
   * Enumerating text rules by hand is what let those gaps exist, so they are
   * now GENERATED from this table crossed with every paintable surface.
   */
  const TEXT_TARGETS = {
    fg: 8.0,
    'fg-2': 5.5,
    'fg-dim': 4.0,
    'fg-muted': 3.0,
    // Decorative only — separators, rules, disabled glyphs. 2.0 makes it visible
    // as ornament, NOT readable as text. The ~107 sites currently using it as
    // text must migrate to fg-muted; no palette can serve both roles, because
    // lifting faint to a readable ratio collapses it into muted.
    'fg-faint': 2.0,
  };

  /**
   * Every surface the app can paint text on. `inset-50` is not a token — it is
   * what SettingsRow.tsx:27 actually paints (`bg-inset/50` over the panel). It
   * escapes the protection cascade at globals.css:887 because that rule matches
   * `.bg-inset` while Tailwind emits `.bg-inset\/50`, a different class. Leaving
   * it out of the matrix is how the app's worst offender went unmeasured.
   */
  const TEXT_SURFACES = ['canvas', 'panel', 'inset', 'well', 'inset-50'];

  /** Text rules, generated. One per (tier, surface) pair — 25 in total. */
  const TEXT_RULES = Object.entries(TEXT_TARGETS).flatMap(([token, threshold]) =>
    TEXT_SURFACES.map((surface) => ({
      name: `${token} on ${surface}`,
      tier: 'HARD',
      type: 'contrast',
      fg: token,
      bg: surface,
      threshold,
      // Resolve bg through the glass composite. Scoped to TEXT rules on purpose:
      // compositing also pulls panel/inset/well toward each other, which would
      // make the SURFACE distinction rules stricter for wallpaper themes. That
      // may well be worth doing, but it is a separate question from text
      // legibility and the solver cannot auto-fix it — so it is not bundled here.
      composite: true,
      description: `${token} must stay legible on ${surface}`,
    })),
  );

  const RULES = [
    ...TEXT_RULES,

    // ── HARD: UI breaks if these fail ──
    { name: 'on-accent on accent',  tier: 'HARD',    type: 'contrast',    fg: 'on-accent', bg: 'accent',  threshold: 4.5,  description: 'User bubble text and active button text must be readable' },

    // ── SURFACE: Elements disappear if these fail ──
    { name: 'inset vs panel',       tier: 'SURFACE', type: 'distinction', fg: 'inset',     bg: 'panel',   threshold: 1.2,  description: 'Session pills and toggle containers must be visible on header bar' },
    { name: 'canvas vs inset',      tier: 'SURFACE', type: 'distinction', fg: 'canvas',    bg: 'inset',   threshold: 1.3,  description: 'Code blocks must be visible inside assistant bubbles' },
    { name: 'well vs panel',        tier: 'SURFACE', type: 'distinction', fg: 'well',      bg: 'panel',   threshold: 1.15, description: 'Search bar must be visible in command drawer' },
    { name: 'edge on panel',        tier: 'SURFACE', type: 'contrast',    fg: 'edge',      bg: 'panel',   threshold: 1.5,  description: 'Borders must be visible on panel surfaces (session strip, tool cards)' },
    { name: 'edge-dim on panel',    tier: 'SURFACE', type: 'contrast',    fg: 'edge-dim',  bg: 'panel',   threshold: 1.3,  description: 'Dim borders must be visible (chips, code blocks rely on these)' },

    // ── SOFT: Degraded but usable, warn only ──
    // NOTE: 'fg-2 on canvas', 'fg-dim on panel' and 'fg-muted/60 on inset' used
    // to live here. They are superseded by TEXT_RULES, which covers those pairs
    // at HARD against every surface rather than one surface at a warn-only tier.
    { name: 'accent vs inset',      tier: 'SOFT',    type: 'contrast',    fg: 'accent',    bg: 'inset',   threshold: 3.0,  description: 'Active toggle button should stand out from its container' },
    { name: 'on-accent/50 on accent', tier: 'SOFT',  type: 'contrast',    fg: 'on-accent', bg: 'accent',  threshold: 2.0,  fgAlpha: 0.5, description: 'Timestamp text in user bubbles' },
    // The bubble timestamp at AssistantTurnBubble.tsx:411 renders fg-muted/60 on
    // the inset bubble. TEXT_RULES checks fg-muted at full opacity; this keeps
    // the 60% case explicitly covered since alpha is applied at the call site.
    { name: 'fg-muted/60 on inset', tier: 'SOFT',    type: 'contrast',    fg: 'fg-muted',  bg: 'inset',   threshold: 2.0,  fgAlpha: 0.6, description: 'Timestamp text in assistant bubbles' },
  ];

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate one rule against a map of already-parsed colors.
   * Exposed separately so the Kit page can re-check a single token cheaply
   * (e.g. while "nudge to pass" walks a color's lightness).
   *
   * @returns {{rule, status:'PASS'|'FAIL'|'SKIP', actual?, threshold, description, tier, reason?}}
   */
  function evaluateRule(rule, parsed, surfaces) {
    const fgColor = parsed[rule.fg];
    // Text rules resolve their background through the glass composite when the
    // caller supplied one; everything else measures the flat token. `surfaces`
    // is optional so existing callers (the Kit page) keep working unchanged.
    const bgColor = (rule.composite && surfaces && surfaces[rule.bg]) || parsed[rule.bg];

    if (!fgColor || !bgColor) {
      return {
        rule: rule.name,
        tier: rule.tier,
        status: 'SKIP',
        reason: `missing token (${!fgColor ? rule.fg : rule.bg})`,
        threshold: rule.threshold,
        description: rule.description,
      };
    }

    let effectiveFg = fgColor;

    // Handle alpha on the fg token itself (e.g. edge-dim with embedded alpha).
    // Without this, "#A8987A80" measures as if fully opaque and reports nonsense.
    if (fgColor.a < 1) {
      effectiveFg = alphaComposite(fgColor, bgColor, fgColor.a);
    }

    // Handle rule-level alpha (e.g. fg-muted rendered at 60% opacity)
    if (rule.fgAlpha) {
      effectiveFg = alphaComposite(effectiveFg, bgColor, rule.fgAlpha);
    }

    const fgLum = luminance(effectiveFg);
    const bgLum = luminance(bgColor);
    const actual = rule.type === 'contrast'
      ? contrastRatio(fgLum, bgLum)
      : luminanceRatio(fgLum, bgLum);
    const pass = actual >= rule.threshold;

    return {
      rule: rule.name,
      tier: rule.tier,
      status: pass ? 'PASS' : 'FAIL',
      actual: actual.toFixed(2),
      threshold: rule.threshold,
      description: rule.description,
    };
  }

  /**
   * Evaluate every rule against a raw token map (hex strings).
   *
   * @param {Object<string,string>} tokens - e.g. { canvas: '#EDE8DD', ... }
   * @returns {{results:{HARD:[],SURFACE:[],SOFT:[]}, hardFails, surfaceFails,
   *            softWarns, unparsed:string[]}}
   */
  function evaluate(tokens, opts) {
    const o = opts || {};
    const parsed = {};
    const unparsed = [];
    for (const [key, value] of Object.entries(tokens || {})) {
      const c = parseHex(value);
      if (c) parsed[key] = c;
      else unparsed.push(key);
    }

    // ── Resolve EFFECTIVE surfaces ──
    // Wallpaper themes paint panel/inset/well translucently over the background
    // image, so the colour under the text is a composite, not the token. Judging
    // the flat token is pessimistic on light wallpapers and optimistic on dark
    // ones — and the dark case is how meadow-mist shipped at a real 1.01 while
    // every audit in the workspace reported 1.24 and CI stayed green.
    //
    // `wallpaperAvg` is the average colour of the pack's background image; the
    // caller computes it (check-contrast.cjs reads the file). Without it we fall
    // back to flat tokens and flag that the check was not glass-aware.
    const wallpaper = o.wallpaperAvg ? parseHex(o.wallpaperAvg) : null;
    const panelsOpacity = typeof o.panelsOpacity === 'number' ? o.panelsOpacity : 1;
    const glassAware = !!wallpaper && panelsOpacity < 1;

    const surfaces = {};
    if (parsed.canvas) surfaces.canvas = parsed.canvas;
    for (const k of ['panel', 'inset', 'well']) {
      if (!parsed[k]) continue;
      surfaces[k] = glassAware ? alphaComposite(parsed[k], wallpaper, panelsOpacity) : parsed[k];
    }
    // SettingsRow's `bg-inset/50` stack — a real painted surface with no token.
    if (parsed.inset && surfaces.panel) {
      surfaces['inset-50'] = alphaComposite(parsed.inset, surfaces.panel, 0.5);
    }

    const results = { HARD: [], SURFACE: [], SOFT: [] };
    let hardFails = 0, surfaceFails = 0, softWarns = 0;

    for (const rule of RULES) {
      const r = evaluateRule(rule, parsed, surfaces);
      results[rule.tier].push(r);
      if (r.status === 'FAIL') {
        if (rule.tier === 'HARD') hardFails++;
        else if (rule.tier === 'SURFACE') surfaceFails++;
        else softWarns++;
      }
    }

    return { results, hardFails, surfaceFails, softWarns, unparsed, parsed, surfaces, glassAware };
  }

  /**
   * Which rules does a given token participate in? Used by the Kit page to show
   * a per-token badge carrying the WORST ratio that token is involved in.
   */
  function rulesForToken(tokenName) {
    return RULES.filter((r) => r.fg === tokenName || r.bg === tokenName);
  }

  return {
    parseHex,
    luminance,
    contrastRatio,
    luminanceRatio,
    alphaComposite,
    RULES,
    TEXT_TARGETS,
    TEXT_SURFACES,
    evaluateRule,
    evaluate,
    rulesForToken,
  };
});
