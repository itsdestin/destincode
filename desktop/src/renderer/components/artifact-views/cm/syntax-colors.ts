// Syntax-color derivation for the CodeMirror editor (D1, spec §5.2): there is
// NO per-theme syntax token family and none is being added — colors are
// DERIVED from the tokens every theme already has (the same technique
// theme-engine.ts uses for --code), so every community theme gets coherent
// code colors for free with no authoring story or back-fill.
//
// Every output is contrast-guarded against the surface it renders on — the
// tranche-0 Crème lesson is that derive-then-discover-contrast-failure is a
// real shipping bug class, so the guard is part of the derivation, not an
// afterthought, and tests/syntax-colors.test.ts sweeps every built-in theme.
// Pure module: hex in, hex out. No DOM.

export interface SyntaxPalette {
  keyword: string;
  string: string;
  comment: string;
  number: string;
  func: string;
  type: string;
}

export interface SyntaxInputs {
  canvas: string; // the background code renders on
  fg: string;
  fg2: string;
  fgDim: string;
  accent: string;
  link: string;
  /** the already-derived --code color (accent-or-fg2, theme-engine.ts) */
  code: string;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function relLum(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relLum(a);
  const lb = relLum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, bAmount: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([
    ca[0] + (cb[0] - ca[0]) * bAmount,
    ca[1] + (cb[1] - ca[1]) * bAmount,
    ca[2] + (cb[2] - ca[2]) * bAmount,
  ] as [number, number, number]);
}

/** Code is body text — WCAG AA body threshold, matching the app's audits. */
export const SYNTAX_MIN_CONTRAST = 4.5;

/** Walk `color` toward `towards` (normally fg, which passes by construction)
 * until it clears the contrast floor against `bg`. 10% steps: coarse enough to
 * terminate fast, fine enough to keep the hue's character. */
export function ensureContrast(color: string, bg: string, towards: string): string {
  let out = color;
  for (let i = 0; i < 10 && contrastRatio(out, bg) < SYNTAX_MIN_CONTRAST; i++) {
    out = mix(out, towards, 0.1 * (i + 1));
  }
  return contrastRatio(out, bg) >= SYNTAX_MIN_CONTRAST ? out : towards;
}

/**
 * Derive the ~6 highlight roles. Hue variety is bounded by what the theme
 * gives us (accent + link are the only chromatic tokens guaranteed to exist);
 * D1 trades rainbow variety for zero authoring burden.
 */
export function deriveSyntaxColors(t: SyntaxInputs): SyntaxPalette {
  const guard = (c: string) => ensureContrast(c, t.canvas, t.fg);
  return {
    keyword: guard(t.accent),
    string: guard(t.code),
    comment: guard(t.fgDim),
    number: guard(t.link),
    func: guard(mix(t.accent, t.fg, 0.4)),
    type: guard(mix(t.link, t.fg, 0.4)),
  };
}
