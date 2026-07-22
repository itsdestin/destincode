// CodeMirror theme built from the app's CSS tokens at call time (D1, spec
// §5.2): read the computed custom properties the way TerminalView reads
// xterm's colors, derive the syntax palette (syntax-colors.ts, contrast-
// guarded), and hand back extensions. Rebuilt on every theme change by
// CodeEditorView's activeTheme effect.
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { deriveSyntaxColors } from './syntax-colors';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function relLum(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const chan = (i: number) => {
    const c = (parseInt(full.slice(i, i + 2), 16) || 0) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

export function buildCmThemeExtensions(): Extension {
  // The editor renders on --inset (same surface the edit textarea used).
  const inset = cssVar('--inset', '#1E1E1E');
  const palette = deriveSyntaxColors({
    canvas: inset,
    fg: cssVar('--fg', '#E0E0E0'),
    fg2: cssVar('--fg-2', '#B0B0B0'),
    fgDim: cssVar('--fg-dim', '#999999'),
    accent: cssVar('--accent', '#D4D4D4'),
    link: cssVar('--link', '#66AAFF'),
    code: cssVar('--code', '#D4D4D4'),
  });

  const highlight = HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: palette.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: palette.string },
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: palette.comment, fontStyle: 'italic' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: palette.number },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: palette.func },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: palette.type },
  ]);

  // Structural colors reference the live CSS vars directly (they track theme
  // flips without a rebuild); only the SYNTAX palette needs derivation.
  const theme = EditorView.theme({
    '&': {
      backgroundColor: 'var(--inset)',
      color: 'var(--fg)',
      height: '100%',
      fontSize: '13px',
    },
    '.cm-content': {
      fontFamily: "var(--font-mono, 'Cascadia Code', Consolas, monospace)",
      caretColor: 'var(--fg)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--inset)',
      color: 'var(--fg-muted)',
      borderRight: '1px solid var(--edge-dim)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'var(--well)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--fg)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      // Hardcoded alpha over the accent so selections stay visible on every
      // canvas — mirrors the diff renderer's theme-independent tint stance.
      backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--panel)',
      color: 'var(--fg)',
      borderBottom: '1px solid var(--edge)',
    },
    '.cm-panels input, .cm-panels button': {
      backgroundColor: 'var(--well)',
      color: 'var(--fg)',
      border: '1px solid var(--edge)',
    },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--link) 30%, transparent)' },
    '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' },
  }, { dark: relLum(inset) < 0.2 });

  return [theme, syntaxHighlighting(highlight)];
}
