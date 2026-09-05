import { describe, it, expect } from 'vitest';
import { rewriteAssets, resolveAssetFile } from '../dev-dashboard/theme.mjs';

describe('rewriteAssets', () => {
  const base = 'http://127.0.0.1:5240';

  it('rewrites a wallpaper path to a loopback URL', () => {
    const out = rewriteAssets(
      { background: { type: 'image', value: 'assets/wallpaper.jpg' } },
      'golden-sunbreak', base,
    );
    expect(out.background.value).toBe(`${base}/theme-asset/golden-sunbreak/assets/wallpaper.jpg`);
  });

  it('rewrites nested arrays of assets', () => {
    const out = rewriteAssets(
      { companions: [{ asset: 'assets/companions/sun.svg', size: 0.4 }] },
      'golden-sunbreak', base,
    );
    expect(out.companions[0].asset)
      .toBe(`${base}/theme-asset/golden-sunbreak/assets/companions/sun.svg`);
    expect(out.companions[0].size).toBe(0.4);
  });

  it('leaves colours, numbers and absolute URLs alone', () => {
    const out = rewriteAssets(
      { tokens: { accent: '#ffc030' }, background: { value: 'https://x/y.png', opacity: 0.98 } },
      's', base,
    );
    expect(out.tokens.accent).toBe('#ffc030');
    expect(out.background.value).toBe('https://x/y.png');
    expect(out.background.opacity).toBe(0.98);
  });

  it('does not mutate the input', () => {
    const input = { background: { value: 'assets/w.jpg' } };
    rewriteAssets(input, 's', base);
    expect(input.background.value).toBe('assets/w.jpg');
  });
});

describe('resolveAssetFile', () => {
  it('refuses a path that climbs out of the theme directory', () => {
    expect(resolveAssetFile('golden-sunbreak', '../../.ssh/id_rsa')).toBeNull();
    expect(resolveAssetFile('golden-sunbreak', 'assets/../../../etc/passwd')).toBeNull();
  });

  it('refuses a slug that climbs out of the themes directory', () => {
    expect(resolveAssetFile('../..', 'assets/x.png')).toBeNull();
    expect(resolveAssetFile('..', 'manifest.json')).toBeNull();
  });

  it('accepts an ordinary asset path', () => {
    expect(resolveAssetFile('golden-sunbreak', 'assets/wallpaper.jpg'))
      .toMatch(/wecoded-themes\/golden-sunbreak\/assets\/wallpaper\.jpg$/);
  });
});
