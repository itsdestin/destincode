import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { stripComments, RENDERER } from './helpers/guard-scope';

// Guards for tranche 8 (changes 44-51). Two distinct invariants:
//
//   1. Every components/ui/ primitive has at least one real consumer. Seven of
//      them shipped in tranche 0 and then sat unused for weeks, which is how
//      FirstRunView ended up declaring a LOCAL ProgressBar that shadowed the
//      shared one — the copy and the primitive drifted with nothing to catch it.
//   2. The specific idioms tranche 8 retired do not come back.
//
// Source-text assertions rather than render tests, for the same reason as
// overlay-layer-authority: a re-hand-rolled toast renders perfectly and only
// shows up as system-wide inconsistency much later.

const UI_DIR = join(RENDERER, 'components', 'ui');

// WHY comments necessarily quote the idioms they replaced, so a raw grep flags
// the very notes that explain the fix. Strip block comments (covers JSX
// `{/* ... */}`) and whole-line `//` before asserting — the invariant is about
// what ships in a class list, not what the prose may mention. Same trap that bit
// overlay-layer-authority and type-scale-authority; third time, same fix.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

// Everything outside components/ui/ — the primitives referring to each other
// does not make either of them adopted.
const CONSUMERS = walk(RENDERER)
  .filter((f) => !f.startsWith(UI_DIR))
  .map((f) => ({ path: f, src: stripComments(readFileSync(f, 'utf8')) }));

describe('primitive adoption', () => {
  it('every ui/ primitive is used outside components/ui/', () => {
    // Scan EXPORTED COMPONENT NAMES, not filenames. The first version of this
    // test derived names from `^[A-Z]\w*\.tsx` filenames, which silently skipped
    // `states.tsx` — a lowercase filename holding three real primitives
    // (LoadingState, EmptyState, ErrorState). A guard against unadopted
    // primitives that cannot see three of them is the same class of blind spot
    // it was written to catch.
    // Both declaration forms: `export function X` and `export const X = forwardRef(...)`
    // — the primitives are split roughly half and half between them.
    const primitives = readdirSync(UI_DIR)
      .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
      .flatMap((f) => {
        const src = readFileSync(join(UI_DIR, f), 'utf8');
        return [...src.matchAll(/^export (?:function|const) ([A-Z][A-Za-z0-9]*)/gm)].map((m) => m[1]);
      })
      // Drop SCREAMING_CASE exports (FOCUS_RING) — shared class strings, not components.
      .filter((name) => !/^[A-Z0-9_]+$/.test(name));

    // Sanity: if this under-reads, the test goes quietly vacuous. 19 today.
    expect(primitives.length).toBeGreaterThan(15);

    // Two exemptions, for DIFFERENT reasons — both named rather than skipped
    // silently, because an exemption you can't see is how the thing this test
    // guards against happens in the first place. Do NOT add to this list to make
    // the bar green.
    //
    //   ErrorState — REMOVED from this list 2026-07-28 (K5). It was unadopted by
    //     decision: choosing `recoverable` vs `general` at each site is the
    //     error-message audit's own core call, so adopting it early would have
    //     prejudged every one. K5 gave it its first two call sites, and both
    //     modes were chosen deliberately for one verified failure rather than
    //     swept in — the Tailscale install shows the real error with Retry when
    //     it has one, and the two-action fallback when it does not.
    //     THE v1.3.1 AUDIT IS STILL OUTSTANDING. This exemption had to go because
    //     it asserts NON-adoption and would now rot, not because the audit landed.
    //
    //   FieldError — REMOVED from this list 2026-08-16. It was unadopted BY
    //     OVERSIGHT (found when this test started scanning `states.tsx`, a
    //     lowercase filename the first version skipped), not by decision.
    //     SpecialistsSection.tsx (tier-write error) gave it its first real call
    //     site, so the exemption no longer describes reality. The other ~25
    //     sites that still hand-roll `<p className="text-{2,3}xs
    //     text-destructive-fg">` remain unconverted — that migration is still
    //     tracked on the ROADMAP, it just isn't what this exemption was for.
    const INTENTIONALLY_UNADOPTED = new Set<string>([]);

    const unused = primitives.filter(
      (name) =>
        !INTENTIONALLY_UNADOPTED.has(name)
        && !CONSUMERS.some(({ src }) => src.includes(`<${name}`)),
    );
    expect(
      unused,
      'A primitive with no call site is a copy waiting to happen — see FirstRunView\'s '
        + 'local ProgressBar, which shadowed the shared one for weeks. Adopt it or delete it.',
    ).toEqual([]);
  });

  it('the intentionally-unadopted list does not rot', () => {
    // The exemption above is a liability once it stops being true: a primitive
    // that HAS been adopted but is still listed means the list is now hiding
    // whatever gets added next to it.
    const src = readFileSync(join(__dirname, 'primitive-adoption.test.ts'), 'utf8');
    const listed = [...src.matchAll(/INTENTIONALLY_UNADOPTED = new Set\(\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([A-Z]\w*)'/g)].map((x) => x[1]));
    for (const name of listed) {
      expect(
        CONSUMERS.some(({ src: c }) => c.includes(`<${name}`)),
        `${name} is exempt as unadopted but now HAS call sites — remove it from the list.`,
      ).toBe(false);
    }
  });

  it('the toast is not re-hand-rolled', () => {
    // Change 44: two competing implementations, each with its own geometry, its
    // own setTimeout and its own z-index. `fixed bottom-16` was the App one's
    // signature; the timers were where the leaks lived.
    for (const { path, src } of CONSUMERS) {
      expect(src, `${path} must use <Toast>, not a hand-placed toast strip`)
        .not.toMatch(/className="[^"]*fixed bottom-16[^"]*"/);
    }
    const app = readFileSync(join(RENDERER, 'App.tsx'), 'utf8');
    expect(
      app.match(/setTimeout\(\(\) => setToast\(null\)/g) ?? [],
      'The <Toast> primitive owns auto-dismiss; a manual timer here can outlive unmount.',
    ).toEqual([]);
  });

  it('no raw black/white overlay fills remain', () => {
    // Change 41 retired the last `hover:bg-black/20`. A literal black or white
    // wash ignores the theme entirely — it is invisible on some and harsh on
    // others. ThemeScreen's swatch button, the one place with a real reason to
    // sit outside the theme, uses bg-current instead so it tracks the SWATCH.
    for (const { path, src } of CONSUMERS) {
      const hits = src.match(/hover:bg-(black|white)\/\d+/g) ?? [];
      expect(hits, `${path} must not wash with literal black/white`).toEqual([]);
    }
  });

  it('the settings drawer header keeps its macOS traffic-light clearance', () => {
    // Change 50 deleted this header; Destin reversed that on 2026-07-24 after
    // seeing it in dev. What this guards is the COUPLING, which is the part that
    // actually breaks silently: the header element and the padding rule must
    // exist together. During the brief headerless window the padding lived on the
    // scroll body instead — either arrangement is fine, but having the element
    // without the rule puts the first row under the native window buttons on
    // macOS, and no Linux or Windows session would ever notice.
    const panel = readFileSync(join(RENDERER, 'components', 'SettingsPanel.tsx'), 'utf8');
    const css = readFileSync(join(RENDERER, 'styles', 'globals.css'), 'utf8');

    const anchor = panel.includes('settings-drawer-header')
      ? 'settings-drawer-header'
      : 'settings-drawer-body';
    expect(
      panel,
      'The drawer must carry one of the two clearance anchors.',
    ).toContain(anchor);
    expect(
      css.match(new RegExp(`\\.mac-titlebar-inset \\.${anchor}\\s*\\{\\s*padding-top`)),
      `SettingsPanel uses .${anchor}, so globals.css must pad THAT selector — `
        + 'otherwise macOS renders the drawer under the traffic lights.',
    ).not.toBeNull();
  });
});
