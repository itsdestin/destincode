import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { stripComments, RENDERER } from './helpers/guard-scope';

// Guard for K1 (menu-internals tranche 1): a section label has ONE spelling.
//
// Before this, the same four classes shipped in SIX different orders across ~90
// sites, plus two wrong elements (<h4>, and <label> with no htmlFor — an a11y
// defect hiding inside a styling inconsistency).
//
// The assertion is deliberately on the class SET, not on a list of retired
// strings. That is the whole lesson of this task: the original audit grepped one
// ordering, found ~30 sites, and missed a 49-site variant that renders
// identically; a second pass on the set found three more orderings the plan had
// never counted. Tailwind class order is semantically irrelevant but textually
// decisive, so any guard written as "these known-bad strings must not appear"
// only blocks the orderings someone already thought of.
//
// Source-text assertion, not a render test: the failure mode is a future session
// typing the classes in a new order in a new file. It renders identically and
// only shows up as drift.
//
// SCOPED TO text-3xs ON PURPOSE. Two families use the same four classes at other
// sizes and are NOT section labels, so folding them in would be a design change,
// not a normalization:
//   - text-4xs micro-labels (QueuedMessagesStrip, ThemeScreen, a SyncPanel pill)
//   - the marketplace screens' text-xs/text-sm + text-fg-dim + tracking-wide
//     eyebrow headings, which are a distinct heading scale
// Both are recorded as tranche-1 residue rather than silently absorbed here.


const CANONICAL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = walk(RENDERER).map((path) => ({
  path,
  src: stripComments(readFileSync(path, 'utf8')),
}));

/** The class set that makes something a section label, regardless of order. */
function isSectionLabel(tokens: string[]): boolean {
  return (
    tokens.includes('text-3xs')
    && tokens.includes('uppercase')
    && tokens.some((t) => t.startsWith('tracking-wid'))
    && (tokens.includes('text-fg-muted') || tokens.includes('text-fg-dim'))
  );
}

// Two exemptions, named rather than skipped silently, because an exemption you
// cannot see is how the inconsistency this test exists to stop got in.
//
// 1. INTERACTIVE AFFORDANCE — "Show 3 more lines", "Copy", "Clear". They borrow
//    the type treatment but they are actions, not labels: they carry a hover
//    color and deliberately omit font-medium so they do not read as headings.
// 2. CHIP — pill-shaped, with its own background and border. A chip is a value,
//    not a heading over a group.
function isExempt(cls: string): boolean {
  const tokens = cls.split(/\s+/);
  if (cls.includes('hover:text-fg')) return true;
  if (tokens.includes('rounded-full')) return true;
  if (tokens.includes('bg-inset') && tokens.includes('border')) return true;
  return false;
}

describe('section label authority', () => {
  it('every section label spells the recipe the same way', () => {
    const offenders: string[] = [];
    for (const { path, src } of FILES) {
      for (const [, cls] of src.matchAll(/"([^"\n]*)"/g)) {
        if (!isSectionLabel(cls.split(/\s+/))) continue;
        if (cls.includes(CANONICAL) || isExempt(cls)) continue;
        offenders.push(`${path.replace(RENDERER, '')} → "${cls}"`);
      }
    }
    expect(
      offenders,
      `Section labels have one spelling: "${CANONICAL}". `
        + 'Same classes in a different order render identically and defeat every future grep.',
    ).toEqual([]);
  });

  it('the canonical recipe is actually in use', () => {
    // Sanity: if this reads zero the walk broke and the test above is vacuous.
    const users = FILES.filter(({ src }) => src.includes(CANONICAL));
    expect(users.length).toBeGreaterThan(25);
  });

  it('no <h4> stands in as a section label', () => {
    // The app's section headings are <h3>; <h4> here was arbitrary, not a
    // deliberate outline level. (Which level is correct under a dialog title is
    // the <Dialog> shell's call — tranche 2 — not this task's.)
    const offenders = FILES.filter(({ src }) => src.includes(`<h4 className="${CANONICAL}`))
      .map(({ path }) => path.replace(RENDERER, ''));
    expect(offenders).toEqual([]);
  });
});
