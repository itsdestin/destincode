import { describe, it, expect } from 'vitest';
import { resolveAssetPath, resolveAllAssetPaths } from '../src/renderer/themes/theme-asset-resolver';

describe('resolveAssetPath', () => {
  it('returns theme-asset:// URI for a relative path', () => {
    expect(resolveAssetPath('assets/wallpaper.png', 'hello-kitty'))
      .toBe('theme-asset://hello-kitty/assets/wallpaper.png');
  });

  it('returns null for undefined input', () => {
    expect(resolveAssetPath(undefined, 'hello-kitty')).toBeNull();
  });

  it('returns the input unchanged if already a theme-asset:// URI', () => {
    expect(resolveAssetPath('theme-asset://hello-kitty/assets/bg.png', 'hello-kitty'))
      .toBe('theme-asset://hello-kitty/assets/bg.png');
  });

  it('returns the input unchanged for gradient/color values', () => {
    expect(resolveAssetPath('linear-gradient(135deg, #000, #fff)', 'test'))
      .toBe('linear-gradient(135deg, #000, #fff)');
  });

  it('returns the input unchanged for hex color values', () => {
    expect(resolveAssetPath('#1a1a2e', 'test')).toBe('#1a1a2e');
  });

  // The docblock has always promised to pass through "already-resolved URIs",
  // but only theme-asset:// was actually handled — everything else got the
  // relative-path treatment and came back as `theme-asset://slug/data:image/...`,
  // which resolves to nothing. A theme shipping an inline data URI, a remote
  // image, or a root-absolute path was silently broken.
  it.each([
    ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['data:image/png;base64,iVBORw0KGgo='],
    ['https://example.com/pattern.svg'],
    ['http://localhost:5233/dev/workbench/fixtures/themes/x/assets/pattern.svg'],
    ['/dev/workbench/fixtures/themes/x/assets/pattern.svg'],
  ])('returns %s unchanged — it is already resolved', (value) => {
    expect(resolveAssetPath(value, 'test')).toBe(value);
  });

  // The inverse still has to hold, or the fix would turn every real asset path
  // into a dead link.
  it('still resolves genuinely relative paths', () => {
    expect(resolveAssetPath('assets/pattern.svg', 'halftone'))
      .toBe('theme-asset://halftone/assets/pattern.svg');
    expect(resolveAssetPath('mascot.png', 'halftone'))
      .toBe('theme-asset://halftone/mascot.png');
  });
});

describe('resolveAllAssetPaths', () => {
  it('resolves background image value to theme-asset URI', () => {
    const theme = {
      name: 'Test', slug: 'test', dark: false,
      tokens: {} as any,
      background: { type: 'image' as const, value: 'assets/bg.png' },
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.background?.value).toBe('theme-asset://test/assets/bg.png');
  });

  it('resolves pattern path', () => {
    const theme = {
      name: 'Test', slug: 'test', dark: false,
      tokens: {} as any,
      background: { type: 'solid' as const, value: '#000', pattern: 'assets/dots.svg', 'pattern-opacity': 0.05 },
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.background?.pattern).toBe('theme-asset://test/assets/dots.svg');
  });

  it('resolves particle-shape, icons, mascot, cursor', () => {
    const theme = {
      name: 'Test', slug: 'test', dark: false,
      tokens: {} as any,
      effects: { particles: 'custom' as const, 'particle-shape': 'assets/heart.svg' },
      icons: { send: 'assets/send.svg' },
      mascot: { idle: 'assets/mascot.svg' },
      cursor: 'assets/cursor.svg',
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.effects?.['particle-shape']).toBe('theme-asset://test/assets/heart.svg');
    expect(resolved.icons?.send).toBe('theme-asset://test/assets/send.svg');
    expect(resolved.mascot?.idle).toBe('theme-asset://test/assets/mascot.svg');
    expect(resolved.cursor).toBe('theme-asset://test/assets/cursor.svg');
  });

  it('does not modify youcoded-core themes', () => {
    const theme = {
      name: 'Light', slug: 'light', dark: false, source: 'youcoded-core' as const,
      tokens: {} as any,
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved).toEqual(theme);
  });

  it('resolves asset paths for community themes', () => {
    const theme = {
      name: 'Community', slug: 'neon-tokyo', dark: true, source: 'community' as const,
      tokens: {} as any,
      background: { type: 'image' as const, value: 'assets/bg.png' },
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.background?.value).toBe('theme-asset://neon-tokyo/assets/bg.png');
  });
});
