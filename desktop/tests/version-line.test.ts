import { describe, it, expect } from 'vitest';
import { formatVersionLine } from '../src/shared/version-line';

describe('formatVersionLine', () => {
  // Release builds must render exactly as they did before the channel existed.
  it('renders a plain release version with no channel', () => {
    expect(formatVersionLine({ version: '1.2.4' })).toBe('YouCoded 1.2.4');
  });

  it('keeps the Android build number as a middot suffix', () => {
    expect(formatVersionLine({ version: '1.2.1', build: '17' })).toBe('YouCoded 1.2.1 · 17');
  });

  // The reason this module exists: a beta install must be unmistakable.
  it('renders a beta build with a v-prefix and parenthesised channel', () => {
    expect(formatVersionLine({ version: '1.3.0-beta', channel: 'BETA' })).toBe(
      'YouCoded v1.3.0-beta (BETA)',
    );
  });

  // A channel must never be silently dropped just because `build` is also set —
  // if both ever arrive, the channel is the load-bearing one.
  it('prefers the channel over the build number when both are present', () => {
    expect(formatVersionLine({ version: '1.3.0-beta', build: '17', channel: 'BETA' })).toBe(
      'YouCoded v1.3.0-beta (BETA)',
    );
  });

  // Vite's define injects '' (not undefined) for unset env vars, so the empty
  // string must be treated as "no channel" or every release build says "()".
  it('treats an empty channel as absent', () => {
    expect(formatVersionLine({ version: '1.2.4', channel: '' })).toBe('YouCoded 1.2.4');
  });
});
