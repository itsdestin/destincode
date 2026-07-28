// desktop/tests/dialog-chrome-authority.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Guard: nothing inside a dialog paints its own header.
//
// D1 gave <Dialog> the header, the close button, the back chevron and the
// scroll body, because those were exactly the four things SettingsPopup left to
// its callers — and two of its seven callers got the scroll body wrong, shipping
// dialogs that clipped with no way to reach the bottom.
//
// D1 then shipped with SIX views still painting all four themselves, across
// Remote Access, Backup & Sync, Appearance and its theme editor, the sync
// add/edit form and the setup wizard. Between them they held THREE separate
// reimplementations of the back chevron (a fourth was deleted from
// SettingsExplainer by K12), at three sizes with three hover treatments.
//
// The count matters here, because the first report of this residue said
// "three". It was written from memory instead of a search, which is the same
// mistake this suite exists to make impossible for class recipes.

const RENDERER = join(__dirname, '..', 'src', 'renderer');
const IN_SCOPE_DIRS = ['', 'development', 'ui'];

function inScopeFiles(): string[] {
  const files = [join(RENDERER, 'App.tsx')];
  for (const dir of IN_SCOPE_DIRS) {
    const abs = join(RENDERER, 'components', dir);
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.tsx') && !f.includes('.test.')) files.push(join(abs, f));
    }
  }
  return files;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/**
 * The header recipe: a full-width bar with the shell's own padding and bottom
 * border. `shrink-0` is the tell that it sits above a flex-1 scroll body — i.e.
 * that it is dialog chrome rather than a card heading.
 */
const HAND_ROLLED_HEADER = /px-4 py-3 border-b border-edge shrink-0/g;

/**
 * Counted per file, so a surface that legitimately keeps one cannot also grow a
 * second. ONE entry — an earlier draft also listed SessionDrawer as an L1 drawer
 * outside the dialog family, which was true but irrelevant: its headers use
 * `px-3 py-2`, so this recipe never matched them. An exemption for something the
 * guard cannot see is worse than none, because it reads as coverage.
 */
const OWNS_ITS_HEADER: Record<string, { count: number; why: string }> = {
  'SyncSetupWizard.tsx': {
    count: 1,
    why: "the wizard's title is derived from state that legitimately lives inside it — the step, the "
      + 'chosen backend, whether this is a reconnect, and whether it is an additional Google account. '
      + 'Lifting that to SyncPanel would make the parent recompute wizard logic to satisfy a '
      + 'structural rule, which trades one duplication for a worse one. The real fix is for the '
      + 'wizard to own its own <Dialog>, which changes it from replacing the sync panel to stacking '
      + 'over it — a UX decision, not a mechanical one.',
  },
};

describe('dialog chrome', () => {
  it('no view inside a dialog paints its own header', () => {
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      if (name === 'Dialog.tsx') continue;  // where the real one lives
      const n = [...stripComments(readFileSync(file, 'utf8')).matchAll(HAND_ROLLED_HEADER)].length;
      const allowed = OWNS_ITS_HEADER[name]?.count ?? 0;
      if (n !== allowed) drift.push(`${name}: ${n} hand-rolled headers, expected ${allowed}`);
    }
    expect(
      drift,
      'Pass `title`, `onBack` and `headerActions` to <Dialog>. If the view cannot reach its Dialog, '
        + 'lift the state that picks the view up to the component that owns it — that is what '
        + "ThemeScreen's showInfo and editingSlug do.",
    ).toEqual([]);
  });

  it('every exemption still exists and still applies', () => {
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(OWNS_ITS_HEADER)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      expect(
        [...stripComments(readFileSync(abs!, 'utf8')).matchAll(HAND_ROLLED_HEADER)].length,
        `${file} (${why}) no longer has ${count} — update or drop the exemption`,
      ).toBe(count);
    }
  });

  it('only Dialog and the wizard implement a back chevron', () => {
    // Three separate reimplementations existed at three sizes: a 24px rounded
    // button in SyncPanel and the wizard, and a bare "←" glyph in the theme
    // editor. A fourth was deleted from SettingsExplainer by K12.
    const BACK_PATH = 'M15 19l-7-7 7-7';
    const offenders: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      if (name === 'Dialog.tsx' || name === 'SyncSetupWizard.tsx') continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      const n = (src.match(new RegExp(BACK_PATH.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g')) ?? []).length;
      if (n > 0) offenders.push(`${name}: ${n}`);
    }
    expect(offenders, 'The back chevron is <Dialog>\'s `onBack`.').toEqual([]);
  });
});
