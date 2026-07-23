// @vitest-environment jsdom
// unified-diff-fill.test.tsx — pins the `fill` prop that the git review
// timeline relies on (2026-07-23). The review wraps each diff in its own
// 45vh scroll box; UnifiedDiff's internal 15-line preview cap + "Expand"
// button would stack a second, redundant scrollbar inside that box and the
// "Expand" click barely moved anything. `fill` must suppress BOTH the cap and
// the button so the host is the sole scroll surface — this test is the guard
// against that regressing back to the nested-scroll jank Destin reported.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { UnifiedDiff } from '../src/renderer/components/diff/UnifiedDiff';
import type { StructuredPatchHunk } from '../src/shared/types';

afterEach(cleanup);

// A hunk with far more than DIFF_PREVIEW_LINES (15) rows, so the internal cap
// + Expand button WOULD appear without `fill`.
const bigHunk: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 40,
  lines: Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
};

describe('UnifiedDiff fill prop', () => {
  it('without fill: a long diff caps and shows the Expand button', () => {
    render(<UnifiedDiff oldStr="" newStr="" structuredPatch={[bigHunk]} />);
    expect(screen.getByText(/Expand \(40 lines\)/)).toBeInTheDocument();
  });

  it('with fill: no Expand button and no maxHeight cap on the scroll container', () => {
    const { container } = render(
      <UnifiedDiff oldStr="" newStr="" structuredPatch={[bigHunk]} fill />
    );
    // The redundant inner button is gone — the host owns the height cap.
    expect(screen.queryByText(/Expand \(/)).not.toBeInTheDocument();
    // The diff container renders full-height (no inline maxHeight style).
    const diffBox = container.querySelector('.font-mono') as HTMLElement | null;
    expect(diffBox).not.toBeNull();
    expect(diffBox!.style.maxHeight).toBe('');
  });
});
