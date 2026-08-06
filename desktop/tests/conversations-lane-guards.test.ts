import { describe, it, expect } from 'vitest';
import {
  MIN_TRANSCRIPT_BYTES,
  transcriptSkipReason,
  laneMatches,
} from '../src/main/conversations/lane-guards';

// A stat double: the guards only ever need these two members, which is why
// StatLike is narrower than fs.Stats (keeps the module pure + trivially testable).
const stat = (over: { symlink?: boolean; size?: number } = {}) => ({
  isSymbolicLink: () => over.symlink ?? false,
  size: over.size ?? 10_000,
});

describe('transcriptSkipReason', () => {
  // The 687-symlink incident: following a home-slug symlink mis-attributes
  // every linked conversation to the home basename.
  it('skips a symlink regardless of size', () => {
    expect(transcriptSkipReason(stat({ symlink: true }))).toBe('symlink');
    expect(transcriptSkipReason(stat({ symlink: true, size: 0 }))).toBe('symlink');
  });

  it('returns null for a normal file when no size floor is given', () => {
    expect(transcriptSkipReason(stat({ size: 1 }))).toBeNull();
  });

  // Default minBytes is 0 so callers OPT IN to the junk-size gate. listSessionFiles
  // must not start dropping small native sessions when it adopts this helper.
  it('applies the size floor only when one is passed', () => {
    expect(transcriptSkipReason(stat({ size: 100 }))).toBeNull();
    expect(transcriptSkipReason(stat({ size: 100 }), MIN_TRANSCRIPT_BYTES)).toBe('too-small');
    expect(transcriptSkipReason(stat({ size: 10_000 }), MIN_TRANSCRIPT_BYTES)).toBeNull();
  });

  it('checks symlink before size', () => {
    expect(transcriptSkipReason(stat({ symlink: true, size: 1 }), MIN_TRANSCRIPT_BYTES)).toBe('symlink');
  });

  it('exposes the junk threshold used by listPastSessions', () => {
    expect(MIN_TRANSCRIPT_BYTES).toBe(500);
  });
});

describe('laneMatches', () => {
  it('accepts a ref under its own provider lane', () => {
    expect(laneMatches('claude', 'claude/transcripts/proj/abc.jsonl')).toBe(true);
    expect(laneMatches('native', 'native/transcripts/proj/abc.jsonl')).toBe(true);
  });

  // D5, never cross-materialize: a native record pointing into the claude lane
  // must be refused, not indexed under the wrong provider.
  it('rejects a cross-lane ref', () => {
    expect(laneMatches('native', 'claude/transcripts/proj/abc.jsonl')).toBe(false);
    expect(laneMatches('claude', 'native/transcripts/proj/abc.jsonl')).toBe(false);
  });

  // Phantom metadata-only seed records carry an empty ref. They must not pass
  // the lane check — Task 4 skips them explicitly rather than deriving a path.
  it('rejects an empty ref', () => {
    expect(laneMatches('claude', '')).toBe(false);
  });

  // Prefix must be the whole lane segment, not a string prefix.
  it('rejects a lane that is only a string prefix of another', () => {
    expect(laneMatches('native', 'native-other/transcripts/p/a.jsonl')).toBe(false);
  });
});
