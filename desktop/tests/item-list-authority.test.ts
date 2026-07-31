// desktop/tests/item-list-authority.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { inScopeFiles, stripComments, RENDERER, assertScopeIsPopulated } from './helpers/guard-scope';

// Guard for K6 — item lists.
//
// The rule is one line: an action on a list item is a LABELLED <Button size="sm">,
// and a dismiss on a container is <CloseButton>. Neither is a bare glyph.
//
// Change 41 banned hand-rolled glyph buttons and swept the app. FIVE survived,
// which is four more than the spec's "the last bare ✕" claimed — and they were
// not all the same thing. Two were genuine item actions (disconnect a remote
// client, remove a saved device), two were container dismisses wearing a
// reimplemented CloseButton at the wrong size with no focus ring, and one was
// already a proper Button primitive using the glyph as its label. Treating all
// five the same would have been wrong three times over.


/**
 * Bare glyphs still rendered as an element's only child, counted per file.
 *
 * A count rather than a file list, for the same reason the toggle guard uses
 * one: a file can legitimately hold one exempt glyph and still grow a second
 * hand-rolled one, and a file-level exemption would wave both through.
 */
const GLYPH_EXEMPT: Record<string, { count: number; why: string }> = {
  'QueuedMessagesStrip.tsx': {
    count: 1,
    why: 'already a <Button variant="ghost" size="icon"> with a real aria-label and focus ring — '
      + 'the glyph is its visible label, not a hand-rolled button. Compact composer strip, not a settings list.',
  },
};

function bareGlyphs(src: string): number {
  return [...stripComments(src).matchAll(/>\s*✕\s*</g)].length;
}

describe('item list actions', () => {
  it('no bare glyph survives as a list-item action or a container dismiss', () => {
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const n = bareGlyphs(readFileSync(file, 'utf8'));
      const allowed = GLYPH_EXEMPT[name]?.count ?? 0;
      if (n !== allowed) drift.push(`${name}: ${n} bare glyphs, expected ${allowed}`);
    }
    expect(
      drift,
      'A list-item action is a labelled <Button size="sm">. A container dismiss is <CloseButton>. '
        + 'Neither is a bare ✕ in a hand-rolled <button>.',
    ).toEqual([]);
  });

  it('every exemption still exists and still applies', () => {
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(GLYPH_EXEMPT)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      expect(
        bareGlyphs(readFileSync(abs!, 'utf8')),
        `${file} (${why}) no longer has ${count} — update or drop the exemption`,
      ).toBe(count);
    }
  });
});

describe('help text matches the controls it describes', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard that matches nothing PASSES and reads as clean.
    // Three of this workstream's worst misses were exactly that.
    assertScopeIsPopulated(inScopeFiles());
  });

  it('no in-menu copy tells the user to press a control that was removed', () => {
    // K6 deleted the ✕ next to each connected device. The Remote Access
    // explainer literally read "Use the ✕ next to a device under Connected
    // Devices to disconnect it." Help text naming a control that no longer
    // exists is precisely the drift /audit is built to find, and it costs one
    // line to not create. This pins the class of mistake, not just that string.
    const offenders: string[] = [];
    for (const file of inScopeFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // A quoted copy string that instructs the reader to use a glyph.
      for (const m of src.matchAll(/(Use|Tap|Click|Press) the ✕/g)) {
        offenders.push(`${file.replace(RENDERER, '')}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders, 'Name the button by its label, not by a glyph that may be replaced.').toEqual([]);
  });
});
