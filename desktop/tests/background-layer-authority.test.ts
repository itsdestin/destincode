import { describe, it, expect } from 'vitest';
import {
  inScopeFiles,
  readStripped,
  relPath,
  lineAt,
  assertScopeIsPopulated,
  assertPatternMatches,
} from './helpers/guard-scope';

// TWO UNPREFIXED `bg-*` UTILITIES ON ONE ELEMENT DO NOT BLEND — ONE WINS.
//
// This is a source-text guard because the failure is INVISIBLE at every other
// gate. It type-checks, it lints, it renders, and the component test passes:
// you get a background, just not the one the code asks for. Nothing short of
// measuring a pixel can tell the difference.
//
// It shipped. The chess board said `bg-inset bg-accent/[0.07]`, meaning "the
// surface, with a faint tint over it". Only `bg-inset` ever painted, so the
// board's two square shades were the raw surface values one depth-ladder rung
// apart — measured #D7D7D7 vs #F9F9F9 in light and #222222 vs #1C1C1C in dark.
// Square-to-square contrast was 1.05-1.40 where a physical board is nearer
// 2.5-3, which made a bishop's colour unreadable in three of the six themes.
// The board was reviewed twice by eye without anyone catching it.
//
// The fix, and the shape this guard pushes you toward: paint the tint as its
// own absolutely-positioned layer, the way the move highlights already do.
// Layers composite. Competing utilities do not.
//
// `hover:bg-*`, `focus:bg-*`, `disabled:bg-*` and friends are FINE and common
// (80 such strings in the renderer) — they apply in different states and never
// compete. Only bare ones are counted.

/** A `bg-` utility with no variant prefix. The leading boundary is what
 *  excludes `hover:bg-x` — the `:` is not whitespace or a quote. */
const BARE_BG = /(?:^|[\s`])(bg-[\w./[\]%-]+)/g;

/** Any quoted string on one line that mentions a background at all. Class lists
 *  in this tree are single-line string literals or template-literal chunks. */
const CLASS_STRING = /(['"`])([^'"`\n]*?bg-[^'"`\n]*?)\1/g;

function bareBackgroundsIn(classString: string): string[] {
  // Leading space so a class list starting with `bg-` still matches the boundary.
  return [...` ${classString}`.matchAll(BARE_BG)].map((m) => m[1]!);
}

describe('two backgrounds on one element (the invisible-failure guard)', () => {
  it('no class string in the renderer sets two unprefixed backgrounds', () => {
    const files = inScopeFiles(['.tsx', '.ts']);
    assertScopeIsPopulated(files);

    const offenders: string[] = [];
    for (const file of files) {
      // Comments are stripped: this file's own explanation, and ChessBoard's,
      // both quote the offending string on purpose.
      const src = readStripped(file);
      for (const m of src.matchAll(CLASS_STRING)) {
        const bare = bareBackgroundsIn(m[2]!);
        if (bare.length >= 2) {
          offenders.push(`${relPath(file)}:${lineAt(src, m.index!)} — ${bare.join(' + ')}`);
        }
      }
    }
    expect(
      offenders,
      'these set two competing backgrounds; only one paints. Make the second a layer:\n'
      + '  <span className="absolute inset-0" style={{ background: … }} aria-hidden="true" />',
    ).toEqual([]);
  });

  it('the pattern matches the string that actually shipped', () => {
    // A guard whose pattern matches nothing reads green forever. This is the
    // real offender, verbatim from the board before the fix.
    assertPatternMatches(CLASS_STRING, `'bg-inset bg-accent/[0.07]'`, 'class string');
    expect(bareBackgroundsIn('bg-inset bg-accent/[0.07]')).toEqual(['bg-inset', 'bg-accent/[0.07]']);
  });

  it('does not flag a state variant, which is the common legitimate case', () => {
    expect(bareBackgroundsIn('rounded-md bg-panel hover:bg-inset')).toEqual(['bg-panel']);
    expect(bareBackgroundsIn('bg-well hover:bg-edge focus:bg-inset disabled:bg-panel')).toEqual(['bg-well']);
    expect(bareBackgroundsIn('bg-inset/50 hover:bg-inset')).toEqual(['bg-inset/50']);
  });
});
