// Lightweight Excel formula evaluator for the common cases — arithmetic, cell
// references, ranges, comparisons, and the everyday functions. openpyxl / pandas
// (how agents usually generate .xlsx) write formulas WITHOUT cached results, so
// without this a Total column would render blank. This is NOT a full engine;
// anything unsupported throws FormulaError and the caller falls back gracefully.

export class FormulaError extends Error {}

export type CellValue = number | string | boolean | null;
// Resolve a single cell reference (e.g. "B4") to its value.
export type RefResolver = (ref: string) => CellValue;

// ---- column letter <-> number ----
function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numToCol(n: number): string {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function expandRange(a: string, b: string): string[] {
  const pa = a.match(/^\$?([A-Z]+)\$?(\d+)$/), pb = b.match(/^\$?([A-Z]+)\$?(\d+)$/);
  if (!pa || !pb) throw new FormulaError('bad range');
  const c1 = colToNum(pa[1]), r1 = parseInt(pa[2], 10), c2 = colToNum(pb[1]), r2 = parseInt(pb[2], 10);
  const out: string[] = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++)
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++)
      out.push(`${numToCol(c)}${r}`);
  return out;
}

// ---- tokenizer ----
type Tok = { t: 'num' | 'str' | 'bool' | 'ref' | 'range' | 'func' | 'op' | 'lp' | 'rp' | 'comma'; v: string };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const RANGE = /^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+/;
  const REF = /^\$?[A-Z]+\$?\d+/;
  const FUNC = /^[A-Z][A-Z0-9.]*(?=\()/i;
  const NUM = /^\d+(\.\d+)?([eE][+-]?\d+)?/;
  while (i < src.length) {
    const s = src.slice(i);
    const ch = s[0];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '"') {
      const m = s.match(/^"([^"]*)"/);
      if (!m) throw new FormulaError('unterminated string');
      toks.push({ t: 'str', v: m[1] }); i += m[0].length; continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = s.match(FUNC))) { toks.push({ t: 'func', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    if (/^(TRUE|FALSE)\b/i.test(s)) { const w = s.match(/^(TRUE|FALSE)/i)![0]; toks.push({ t: 'bool', v: w.toUpperCase() }); i += w.length; continue; }
    if ((m = s.match(RANGE))) { toks.push({ t: 'range', v: m[0] }); i += m[0].length; continue; }
    if ((m = s.match(REF))) { toks.push({ t: 'ref', v: m[0] }); i += m[0].length; continue; }
    if ((m = s.match(NUM))) { toks.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    if (ch === '(') { toks.push({ t: 'lp', v: ch }); i++; continue; }
    if (ch === ')') { toks.push({ t: 'rp', v: ch }); i++; continue; }
    if (ch === ',') { toks.push({ t: 'comma', v: ch }); i++; continue; }
    // operators: <= >= <> first, then single
    const two = s.slice(0, 2);
    if (two === '<=' || two === '>=' || two === '<>') { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    throw new FormulaError('unexpected char: ' + ch);
  }
  return toks;
}

function toNum(v: CellValue): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) throw new FormulaError('not a number: ' + v);
  return n;
}

// ---- recursive-descent parser/evaluator ----
function evaluate(toks: Tok[], resolve: RefResolver): CellValue {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parseComparison(): CellValue {
    let left = parseAdd();
    while (peek()?.t === 'op' && ['=', '<', '>', '<=', '>=', '<>'].includes(peek().v)) {
      const op = next().v;
      const right = parseAdd();
      const a = left, b = right;
      // Numeric compare when both sides are number/boolean/EMPTY — Excel
      // coerces an empty cell to 0 in numeric comparisons (Z9=0 is TRUE for a
      // blank Z9). Strings compare as strings.
      const numish = (x: CellValue) => typeof x === 'number' || typeof x === 'boolean' || x == null;
      const cmp = numish(a) && numish(b)
        ? [toNum(a), toNum(b)] as const
        : [String(a ?? ''), String(b ?? '')] as const;
      switch (op) {
        case '=': left = cmp[0] === cmp[1]; break;
        case '<>': left = cmp[0] !== cmp[1]; break;
        case '<': left = cmp[0] < cmp[1]; break;
        case '>': left = cmp[0] > cmp[1]; break;
        case '<=': left = cmp[0] <= cmp[1]; break;
        case '>=': left = cmp[0] >= cmp[1]; break;
      }
    }
    return left;
  }
  function parseAdd(): CellValue {
    let left = parseMul();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-' || peek().v === '&')) {
      const op = next().v;
      const right = parseMul();
      if (op === '&') left = String(left ?? '') + String(right ?? '');
      else left = op === '+' ? toNum(left) + toNum(right) : toNum(left) - toNum(right);
    }
    return left;
  }
  function parseMul(): CellValue {
    let left = parsePow();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v;
      const right = parsePow();
      if (op === '/') {
        const d = toNum(right);
        // Excel shows #DIV/0!; our documented degrade is blank-on-error, so
        // throw rather than let Infinity/NaN render as cell text.
        if (d === 0) throw new FormulaError('division by zero');
        left = toNum(left) / d;
      } else {
        left = toNum(left) * toNum(right);
      }
    }
    return left;
  }
  function parsePow(): CellValue {
    let left = parseUnary();
    while (peek()?.t === 'op' && peek().v === '^') {
      next();
      const right = parseUnary();
      left = Math.pow(toNum(left), toNum(right));
    }
    return left;
  }
  function parseUnary(): CellValue {
    if (peek()?.t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = next().v;
      const v = parseUnary();
      return op === '-' ? -toNum(v) : toNum(v);
    }
    let v = parsePrimary();
    // percent postfix
    while (peek()?.t === 'op' && peek().v === '%') { next(); v = toNum(v) / 100; }
    return v;
  }
  function rangeValues(rangeTok: string): CellValue[] {
    const [a, b] = rangeTok.split(':');
    return expandRange(a, b).map((ref) => resolve(ref.replace(/\$/g, '')));
  }
  function parsePrimary(): CellValue {
    const tk = peek();
    if (!tk) throw new FormulaError('unexpected end');
    if (tk.t === 'num') { next(); return parseFloat(tk.v); }
    if (tk.t === 'str') { next(); return tk.v; }
    if (tk.t === 'bool') { next(); return tk.v === 'TRUE'; }
    if (tk.t === 'ref') { next(); return resolve(tk.v.replace(/\$/g, '')); }
    if (tk.t === 'range') { next(); const vs = rangeValues(tk.v); return vs.length ? toNum(vs[0]) : 0; }
    if (tk.t === 'lp') { next(); const v = parseComparison(); if (peek()?.t !== 'rp') throw new FormulaError('expected )'); next(); return v; }
    if (tk.t === 'func') return parseFunc();
    throw new FormulaError('unexpected token: ' + tk.v);
  }
  function collectArgs(): { values: CellValue[]; flat: number[] } {
    // Parse comma-separated args until ). Ranges contribute multiple numbers to `flat`.
    next(); // consume '('
    const values: CellValue[] = [];
    const flat: number[] = [];
    if (peek()?.t === 'rp') { next(); return { values, flat }; }
    for (;;) {
      if (peek()?.t === 'range') {
        const vs = rangeValues(next().v);
        values.push(vs.length ? vs[0] : null);
        for (const v of vs) if (v != null && v !== '' && typeof v !== 'string') flat.push(toNum(v));
      } else {
        const v = parseComparison();
        values.push(v);
        if (v != null && v !== '' && typeof v !== 'string' && typeof v !== 'boolean') flat.push(toNum(v));
        else if (typeof v === 'boolean') flat.push(v ? 1 : 0);
      }
      if (peek()?.t === 'comma') { next(); continue; }
      break;
    }
    if (peek()?.t !== 'rp') throw new FormulaError('expected )');
    next();
    return { values, flat };
  }
  // Consume the tokens of one argument WITHOUT evaluating it — used by IF to
  // short-circuit the untaken branch. Tracks paren depth so nested calls and
  // grouped expressions skip correctly; stops at a top-level comma or ')'.
  function skipArg(): void {
    let depth = 0;
    while (pos < toks.length) {
      const tk = peek();
      if (tk.t === 'lp') depth++;
      else if (tk.t === 'rp') { if (depth === 0) return; depth--; }
      else if (tk.t === 'comma' && depth === 0) return;
      next();
    }
  }

  // IF evaluates lazily like real Excel: only the TAKEN branch runs, so an
  // unsupported function or a division-by-zero in the untaken branch can't
  // blank an otherwise-computable cell (that was a real rendering bug —
  // IF(cond, SUM(...), VLOOKUP(...)) always went blank).
  function parseIf(): CellValue {
    if (peek()?.t !== 'lp') throw new FormulaError('expected (');
    next();
    const cond = parseComparison();
    const truthy = typeof cond === 'string' ? cond.length > 0 : !!cond;
    // Defaults match Excel-ish behavior when a branch is omitted:
    // truthy with no value arg → 0; falsy with no else arg → FALSE.
    let result: CellValue = truthy ? 0 : false;
    if (peek()?.t === 'comma') {
      next();
      if (truthy) result = parseComparison(); else skipArg();
      if (peek()?.t === 'comma') {
        next();
        if (!truthy) result = parseComparison(); else skipArg();
      }
    }
    if (peek()?.t !== 'rp') throw new FormulaError('expected )');
    next();
    return result;
  }

  function parseFunc(): CellValue {
    const name = next().v;
    if (name === 'IF') return parseIf();
    const { values, flat } = collectArgs();
    switch (name) {
      case 'SUM': return flat.reduce((a, b) => a + b, 0);
      case 'PRODUCT': return flat.reduce((a, b) => a * b, 1);
      case 'AVERAGE': case 'AVG': return flat.length ? flat.reduce((a, b) => a + b, 0) / flat.length : 0;
      case 'MIN': return flat.length ? Math.min(...flat) : 0;
      case 'MAX': return flat.length ? Math.max(...flat) : 0;
      case 'COUNT': return flat.length;
      case 'COUNTA': return values.filter((v) => v != null && v !== '').length;
      case 'ROUND': { const d = values[1] != null ? toNum(values[1]) : 0; const f = Math.pow(10, d); return Math.round(toNum(values[0]) * f) / f; }
      case 'ABS': return Math.abs(toNum(values[0]));
      case 'SQRT': return Math.sqrt(toNum(values[0]));
      case 'POWER': return Math.pow(toNum(values[0]), toNum(values[1]));
      case 'INT': return Math.floor(toNum(values[0]));
      case 'CONCATENATE': case 'CONCAT': return values.map((v) => String(v ?? '')).join('');
      default: throw new FormulaError('unsupported function: ' + name);
    }
  }

  const result = parseComparison();
  if (pos < toks.length) throw new FormulaError('trailing tokens');
  return result;
}

// Evaluate a formula string (with or without a leading '='). Throws FormulaError
// on anything it can't handle so the caller can fall back to blank.
export function evalFormula(formula: string, resolve: RefResolver): CellValue {
  const src = formula.replace(/^=/, '').trim();
  if (!src) return '';
  const result = evaluate(tokenize(src), resolve);
  // A non-finite number (overflow via ^, residual Infinity from resolved cell
  // values) must not render as "Infinity"/"NaN" text — blank instead.
  if (typeof result === 'number' && !Number.isFinite(result)) {
    throw new FormulaError('non-finite result');
  }
  return result;
}
