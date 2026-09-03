import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

/**
 * ROADMAP "Adopt the `FieldError` primitive": 25 sites across 14 files wrote the
 * primitive's exact markup by hand. They are gone; this keeps them gone.
 *
 * The check is on the CLASS PAIR, because that pair *is* the primitive's body —
 * anything that renders it by hand is a copy, and the copies drift (the sweep
 * found the app split between text-3xs and text-2xs, which is why the primitive
 * gained a `size` prop rather than silently resizing six lines).
 *
 * Each exemption below is a site that matches the pair but is NOT a field error.
 * A new one needs a reason here, not just a name.
 */
const EXEMPT: Record<string, { count: number; why: string }> = {
  // Four copies of one static caption under the skip-permissions toggle. Not a
  // failure report — it is always-on warning copy, and FieldError carries
  // role="alert", which would make a screen reader interrupt with it every time
  // the toggle flips. Their real problem is that there are four of them; the fix
  // is a shared warning component, not this primitive.
  'App.tsx': { count: 1, why: 'skip-permissions caption, not a field error' },
  'SessionStrip.tsx': { count: 1, why: 'skip-permissions caption, not a field error' },
  'ResumeBrowser.tsx': { count: 1, why: 'skip-permissions caption, not a field error' },
  'ResumeOptionsPopover.tsx': { count: 1, why: 'skip-permissions caption, not a field error' },
  // NOT here: SettingsPanel's confirm-dialog prose. It is dimmed to
  // `text-destructive-fg/80`, and the pattern below excludes the opacity
  // variants on purpose — an opacity modifier is prose styling, not this
  // primitive's body. So it needs no exemption, and granting one would have
  // exempted a file full of real fields.
  // A destructive text BUTTON (hover fill, padding, rounded), not an error line.
  'GitReviewView.tsx': { count: 1, why: 'destructive text button' },
  // Deliberately role="status" (polite): a failed update check must not
  // interrupt what the user is reading. FieldError is role="alert".
  'UpdateButton.tsx': { count: 1, why: 'role="status" by design' },
};

/** How many times a file writes the primitive's class pair by hand. The pattern
 *  is deliberately NOT anchored to a tag: a copy is a copy whether it lands on a
 *  <p>, a <span> or a <div>. `text-destructive-fg/80` (an opacity variant) is
 *  excluded — that is prose styling, not this primitive. */
function handRolledCount(src: string): number {
  return (src.match(/text-[23]xs text-destructive-fg(?![/\w-])/g) ?? []).length;
}

describe('FieldError adoption', () => {
  it('no file hand-rolls the primitive markup', () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER)) {
      if (file.endsWith(join('ui', 'states.tsx'))) continue; // the primitive itself
      const base = file.split(/[\\/]/).pop()!;
      if (base in EXEMPT) continue;
      if (handRolledCount(readFileSync(file, 'utf8')) > 0) offenders.push(base);
    }
    expect(
      offenders,
      'Use <FieldError> (components/ui/states.tsx). If the site is not a field '
        + 'error, add it to EXEMPT above with the reason.',
    ).toEqual([]);
  });

  // COUNTS, not just names. Exempting a whole FILE would let the next
  // hand-rolled copy hide inside one — SettingsPanel is exempt for exactly one
  // paragraph and holds plenty of real fields, so "SettingsPanel is allowed to
  // match" is too coarse a permission to grant.
  it('an exemption covers exactly the occurrences it was granted for', () => {
    const counts = new Map(
      walk(RENDERER).map((f) => [f.split(/[\\/]/).pop()!, handRolledCount(readFileSync(f, 'utf8'))]),
    );
    for (const [name, { count, why }] of Object.entries(EXEMPT)) {
      expect(counts.get(name) ?? 0, `${name} (exempt: ${why})`).toBe(count);
    }
  });

  it('every exemption still matches something', () => {
    // An exemption that stops being true is a place for the next copy to hide.
    const seen = new Set(
      walk(RENDERER)
        .filter((f) => handRolledCount(readFileSync(f, 'utf8')) > 0)
        .map((f) => f.split(/[\\/]/).pop()!),
    );
    for (const name of Object.keys(EXEMPT)) {
      expect(seen.has(name), `${name} no longer hand-rolls it — drop the exemption.`).toBe(true);
    }
  });
});
