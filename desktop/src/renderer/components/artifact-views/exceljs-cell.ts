// Pure helpers that map an ExcelJS cell's value + style into display text and
// CSS — used by XlsxView to render a workbook with real fidelity (fills, fonts,
// borders, number formats) inside a spreadsheet-style grid. No React / no I/O so
// these stay unit-testable.
import type { CSSProperties } from 'react';

// 1 → "A", 26 → "Z", 27 → "AA"
export function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ExcelJS colors are ARGB hex like "FF217346" (or "66FF0000" with alpha). Map to
// a CSS color. Theme/indexed colors aren't resolved here (no palette) — they
// return undefined so the cell keeps the default look. openpyxl-generated files
// (the common agent case) use explicit ARGB, so this covers them well.
export function argbToCss(color: any): string | undefined {
  const argb: string | undefined = color?.argb;
  if (!argb || typeof argb !== 'string' || argb.length < 6) return undefined;
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  const alpha = argb.length === 8 ? parseInt(argb.slice(0, 2), 16) / 255 : 1;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return undefined;
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha.toFixed(3)})` : `#${hex.toLowerCase()}`;
}

// Extract a plain string from an ExcelJS cell value, which can be a primitive,
// a Date, a formula object { formula, result }, rich text, or a hyperlink.
export function cellRawValue(value: any): { text: string; isNumber: boolean; date: Date | null } {
  if (value == null) return { text: '', isNumber: false, date: null };
  if (value instanceof Date) return { text: '', isNumber: false, date: value };
  if (typeof value === 'number') return { text: String(value), isNumber: true, date: null };
  if (typeof value === 'string' || typeof value === 'boolean') return { text: String(value), isNumber: false, date: null };
  // formula cell → display the computed result
  if (typeof value === 'object') {
    if ('result' in value) {
      const r = (value as any).result;
      if (r instanceof Date) return { text: '', isNumber: false, date: r };
      if (typeof r === 'number') return { text: String(r), isNumber: true, date: null };
      return { text: r == null ? '' : String(r), isNumber: false, date: null };
    }
    if ('richText' in value && Array.isArray((value as any).richText)) {
      return { text: (value as any).richText.map((t: any) => t.text).join(''), isNumber: false, date: null };
    }
    if ('text' in value) return { text: String((value as any).text), isNumber: false, date: null };
    if ('hyperlink' in value) return { text: String((value as any).text ?? (value as any).hyperlink), isNumber: false, date: null };
  }
  return { text: String(value), isNumber: false, date: null };
}

// General number rendering — trims float noise without forcing a precision.
function generalNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // round to 10 sig digits to kill 0.1+0.2 style artifacts, then trim zeros
  return String(parseFloat(n.toPrecision(12)));
}

function formatDate(d: Date, numFmt?: string): string {
  const fmt = (numFmt ?? '').toLowerCase();
  const hasTime = /[hms]/.test(fmt);
  const hasDate = /[ymd]/.test(fmt);
  if (hasTime && !hasDate) return d.toLocaleTimeString();
  if (hasTime) return d.toLocaleString();
  return d.toLocaleDateString();
}

// Apply an Excel number-format string to a value. This is a compact formatter
// covering the common cases (General, integers, thousands separators, decimals,
// percent, currency, dates) — enough for the vast majority of real sheets. Exotic
// custom formats fall back to a sensible default rather than throwing.
export function formatCellNumber(value: any, numFmt?: string): string {
  const { text, isNumber, date } = cellRawValue(value);
  if (date) return formatDate(date, numFmt);
  if (!isNumber) return text;
  const n = Number(text);
  if (!numFmt || numFmt === 'General') return generalNumber(n);

  const isPct = numFmt.includes('%');
  const scaled = isPct ? n * 100 : n;
  const dot = numFmt.match(/\.(0+)/);
  const decimals = dot ? dot[1].length : 0;
  // thousands separator if the integer part of the format has a grouping comma
  const intPart = numFmt.split('.')[0];
  const useThousands = /[#0],[#0]/.test(intPart);

  let s: string;
  if (decimals > 0 || useThousands) {
    s = scaled.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: useThousands });
  } else {
    s = generalNumber(scaled);
  }
  const cur = numFmt.match(/[$€£¥]/);
  if (cur) s = cur[0] + s;
  if (isPct) s = s + '%';
  return s;
}

// Map an ExcelJS cell's style into CSS. Returns background (fill), text color +
// weight + style + size (font), per-side borders, and alignment.
export function cellStyleToCss(cell: any): CSSProperties {
  const css: CSSProperties = {};
  const font = cell?.font;
  if (font) {
    if (font.bold) css.fontWeight = 700;
    if (font.italic) css.fontStyle = 'italic';
    if (font.underline) css.textDecoration = 'underline';
    if (font.size) css.fontSize = `${font.size}px`;
    if (font.name) css.fontFamily = `"${font.name}", sans-serif`;
    const fc = argbToCss(font.color);
    if (fc) css.color = fc;
  }
  // Fill — solid pattern fills are the common case.
  const fill = cell?.fill;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const bg = argbToCss(fill.fgColor);
    if (bg) css.backgroundColor = bg;
  }
  // Borders — map each side's style to a CSS width; honor color.
  const b = cell?.border;
  if (b) {
    const side = (s: any): string | undefined => {
      if (!s || !s.style) return undefined;
      const w = s.style === 'thick' || s.style === 'medium' ? 2 : 1;
      const col = argbToCss(s.color) ?? '#b0b0b0';
      const dash = s.style.includes('dash') ? 'dashed' : s.style.includes('dot') ? 'dotted' : 'solid';
      return `${w}px ${dash} ${col}`;
    };
    const t = side(b.top), l = side(b.left), bo = side(b.bottom), r = side(b.right);
    if (t) css.borderTop = t;
    if (l) css.borderLeft = l;
    if (bo) css.borderBottom = bo;
    if (r) css.borderRight = r;
  }
  // Alignment — explicit overrides the value-type default.
  const a = cell?.alignment;
  if (a?.horizontal) css.textAlign = a.horizontal as any;
  if (a?.vertical) css.verticalAlign = a.vertical === 'middle' ? 'middle' : (a.vertical as any);
  if (a?.wrapText) css.whiteSpace = 'normal';
  return css;
}

// Excel column width units → CSS pixels (≈ width * 7 + a little padding). Used
// to honor the file's column widths so the layout matches the source.
export function colWidthToPx(width: number | undefined): number {
  if (!width || width <= 0) return 80;
  return Math.round(width * 7 + 5);
}

export interface MergeInfo {
  // key "r:c" → span for the master (top-left) cell of a merge
  masters: Map<string, { rowSpan: number; colSpan: number }>;
  // keys "r:c" of non-master cells covered by a merge (skip when rendering)
  covered: Set<string>;
}

function parseRef(ref: string): { row: number; col: number } {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return { row: 1, col: 1 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10), col };
}

// Parse ExcelJS merge ranges (e.g. ["A1:B2", "C1:C3"]) into master spans +
// covered cells so the grid can render colSpan/rowSpan and skip hidden cells.
export function parseMerges(ranges: string[] | undefined): MergeInfo {
  const masters = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const range of ranges ?? []) {
    const [a, b] = range.split(':');
    if (!a || !b) continue;
    const tl = parseRef(a), br = parseRef(b);
    const rowSpan = br.row - tl.row + 1;
    const colSpan = br.col - tl.col + 1;
    masters.set(`${tl.row}:${tl.col}`, { rowSpan, colSpan });
    for (let r = tl.row; r <= br.row; r++) {
      for (let c = tl.col; c <= br.col; c++) {
        if (r === tl.row && c === tl.col) continue;
        covered.add(`${r}:${c}`);
      }
    }
  }
  return { masters, covered };
}
