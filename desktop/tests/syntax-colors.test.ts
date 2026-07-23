// Pins the D1 syntax-color derivation: every derived role must clear the
// contrast floor on EVERY built-in theme's editor surface (--inset). This is
// the tranche-0 Crème lesson as a test — colors derived from tokens and then
// discovered to fail contrast on some theme is a real shipping bug class, so
// the sweep runs at test time, not at Destin's-eyeball time.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { deriveSyntaxColors, contrastRatio, SYNTAX_MIN_CONTRAST } from '../src/renderer/components/artifact-views/cm/syntax-colors';

const builtinDir = path.join(__dirname, '../src/renderer/themes/builtin');
const themes = fs.readdirSync(builtinDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(builtinDir, f), 'utf8')));

describe('deriveSyntaxColors contrast sweep', () => {
  for (const theme of themes) {
    it(`every role clears ${SYNTAX_MIN_CONTRAST}:1 on ${theme.name}'s inset surface`, () => {
      const t = theme.tokens;
      const pal = deriveSyntaxColors({
        canvas: t.inset,
        fg: t.fg,
        fg2: t['fg-2'],
        fgDim: t['fg-dim'],
        accent: t.accent,
        link: t.link,
        // --code derives as accent-or-fg2 in theme-engine; accent approximates
        code: t.accent,
      });
      for (const [role, color] of Object.entries(pal)) {
        const ratio = contrastRatio(color, t.inset);
        expect(ratio, `${theme.name} ${role} (${color}) on ${t.inset} = ${ratio.toFixed(2)}`)
          .toBeGreaterThanOrEqual(SYNTAX_MIN_CONTRAST);
      }
    });
  }

  it('walks a failing color toward fg instead of shipping it', () => {
    // A low-contrast accent on a dark canvas must not survive as-is.
    const pal = deriveSyntaxColors({
      canvas: '#111111', fg: '#E0E0E0', fg2: '#B0B0B0', fgDim: '#333333',
      accent: '#222222', link: '#1A1A2E', code: '#222222',
    });
    for (const color of Object.values(pal)) {
      expect(contrastRatio(color, '#111111')).toBeGreaterThanOrEqual(SYNTAX_MIN_CONTRAST);
    }
  });
});
