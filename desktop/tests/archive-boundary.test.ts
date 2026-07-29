// The visible half of the /clear fix. Entries above a `clear` marker must render
// faded and archived, exactly as entries above a `compact` marker already did —
// keeping the timeline is pointless if nothing signals those messages are out of
// the model's context.
//
// This imports the SAME function ChatView renders with. An earlier draft of this
// test re-implemented the loop locally and passed against its own copy; that is
// the trap this branch has already hit three times (a stored-but-never-compared
// key, an exported-but-never-called monotonic, a five-green-test helper nothing
// invoked), so the logic lives in a module both sides import.
import { describe, it, expect } from 'vitest';
import { findArchiveBoundary } from '../src/renderer/state/archive-boundary';
import type { TimelineEntry } from '../src/renderer/state/chat-types';

const user = { kind: 'user', message: { id: 'm', role: 'user', content: 'x', timestamp: 1 } } as TimelineEntry;
const marker = (variant: 'clear' | 'compact' | 'info') =>
  ({ kind: 'system-marker', marker: { id: variant, timestamp: 1, label: variant, variant } }) as TimelineEntry;

describe('findArchiveBoundary', () => {
  it('a clear marker archives everything above it', () => {
    expect(findArchiveBoundary([user, user, marker('clear'), user]))
      .toEqual({ index: 2, kind: 'clear' });
  });

  it('a compact marker still does, unchanged', () => {
    expect(findArchiveBoundary([user, marker('compact'), user]).kind).toBe('compact');
  });

  it('the LAST boundary wins when both are present', () => {
    // Compact then clear: only what is above the CLEAR is out of context.
    expect(findArchiveBoundary([user, marker('compact'), user, marker('clear'), user]))
      .toEqual({ index: 3, kind: 'clear' });
  });

  it('an ordinary info marker is NOT a boundary', () => {
    // Only compact and clear reset the model's context; a divider does not.
    expect(findArchiveBoundary([user, marker('info'), user]).index).toBe(-1);
  });

  it('no marker means nothing is faded', () => {
    expect(findArchiveBoundary([user, user])).toEqual({ index: -1, kind: null });
  });

  it('entries BELOW the boundary are never archived', () => {
    const tl = [user, marker('clear'), user, user];
    const { index } = findArchiveBoundary(tl);
    expect(tl.map((_, i) => index >= 0 && i < index)).toEqual([true, false, false, false]);
  });

  it('an empty timeline is not a crash', () => {
    expect(findArchiveBoundary([])).toEqual({ index: -1, kind: null });
  });
});
