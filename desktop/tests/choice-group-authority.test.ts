import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard for K3: "pick one of N" has one implementation.
//
// Seven hand-rolled groups shipped alongside SegmentedTabs -- 4 corner radii,
// 4 text sizes, 3 inactive treatments, for one function. Tranche 8 adopted the
// primitive in 2 places; this retires the rest.
//
// The retired signature is a flex-1 button carrying its own active/inactive
// pair. Matching on `bg-accent text-on-accent` alone would flag legitimate
// non-choice uses (badges, the InputBar send button), so the assertion is the
// full retired class fragments.

const RENDERER = join(__dirname, '..', 'src', 'renderer');

const RETIRED = [
  'flex-1 px-1.5 py-1 rounded-sm',
  'flex-1 px-1.5 py-1.5 rounded-sm',
  'flex-1 py-1.5 px-3 text-sm rounded',
  'px-2 py-1 rounded text-3xs',
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

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

describe('choice group authority', () => {
  it('no hand-rolled segmented control ships', () => {
    const offenders: string[] = [];
    for (const { path, src } of FILES) {
      for (const fragment of RETIRED) {
        if (src.includes(fragment)) {
          offenders.push(`${path.replace(RENDERER, '')} → "${fragment}"`);
        }
      }
    }
    expect(
      offenders,
      'Pick-one-of-N goes through <SegmentedTabs>. '
        + '<=4 short options: segmented. Needs a description: radio list. >5: Select.',
    ).toEqual([]);
  });

  it('SegmentedTabs has real consumers', () => {
    const users = FILES.filter(
      ({ path, src }) => !path.includes(join('components', 'ui')) && src.includes('<SegmentedTabs'),
    );
    expect(users.length).toBeGreaterThanOrEqual(4);
  });
});
