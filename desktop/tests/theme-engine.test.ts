import { describe, it, expect } from 'vitest';
import { buildTokenCSS, buildShapeCSS, buildBackgroundStyle, buildLayoutAttrs, buildPatternStyle, computeOverlayTokens } from '../src/renderer/themes/theme-engine';

const TOKENS = {
  canvas: '#0D0F1A', panel: '#141726', inset: '#1F2440', well: '#0D0F1A',
  accent: '#7C6AF7', 'on-accent': '#FFFFFF',
  fg: '#C4BFFF', 'fg-2': '#9090C0', 'fg-dim': '#6060A0',
  'fg-muted': '#404070', 'fg-faint': '#282848',
  edge: '#2A2F55', 'edge-dim': '#2A2F5580',
  'scrollbar-thumb': '#2A2F55', 'scrollbar-hover': '#3A3F70',
};

describe('buildTokenCSS', () => {
  it('returns an object of CSS property → value pairs', () => {
    const result = buildTokenCSS(TOKENS);
    expect(result['--canvas']).toBe('#0D0F1A');
    expect(result['--accent']).toBe('#7C6AF7');
    expect(result['--on-accent']).toBe('#FFFFFF');
    expect(Object.keys(result)).toHaveLength(15);
  });
});

describe('buildShapeCSS', () => {
  it('returns radius CSS properties', () => {
    const result = buildShapeCSS({ 'radius-sm': '2px', 'radius-md': '4px', 'radius-lg': '8px', 'radius-full': '9999px' });
    expect(result['--radius-sm']).toBe('2px');
    expect(result['--radius-full']).toBe('9999px');
  });

  it('returns empty object for undefined shape', () => {
    expect(buildShapeCSS(undefined)).toEqual({});
  });

  it('skips empty string values and includes non-empty values', () => {
    const result = buildShapeCSS({ 'radius-sm': '', 'radius-md': '4px' });
    expect('--radius-sm' in result).toBe(false);
    expect(result['--radius-md']).toBe('4px');
  });
});

describe('buildBackgroundStyle', () => {
  it('returns gradient CSS for gradient type', () => {
    const result = buildBackgroundStyle({ type: 'gradient', value: 'linear-gradient(135deg, #000, #fff)' });
    expect(result?.background).toBe('linear-gradient(135deg, #000, #fff)');
  });

  it('returns image CSS for image type', () => {
    const result = buildBackgroundStyle({ type: 'image', value: 'https://example.com/bg.jpg' });
    expect(result?.backgroundImage).toBe('url("https://example.com/bg.jpg")');
    expect(result?.backgroundSize).toBe('cover');
  });

  it('returns solid CSS for solid type', () => {
    const result = buildBackgroundStyle({ type: 'solid', value: '#1a1a2e' });
    expect(result?.background).toBe('#1a1a2e');
  });

  it('passes opacity through to the result', () => {
    const result = buildBackgroundStyle({ type: 'solid', value: '#1a1a2e', opacity: 0.8 });
    expect(result?.opacity).toBe('0.8');
  });

  it('returns null for undefined background', () => {
    expect(buildBackgroundStyle(undefined)).toBeNull();
  });
});

describe('buildLayoutAttrs', () => {
  it('returns data attribute values for each layout field', () => {
    const result = buildLayoutAttrs({ 'input-style': 'floating', 'bubble-style': 'pill' });
    expect(result['data-input-style']).toBe('floating');
    expect(result['data-bubble-style']).toBe('pill');
    expect(result['data-header-style']).toBeUndefined();
  });

  it('returns empty object for undefined layout', () => {
    expect(buildLayoutAttrs(undefined)).toEqual({});
  });
});

describe('buildPatternStyle', () => {
  it('returns repeating background style for pattern', () => {
    const result = buildPatternStyle('theme-asset://hello-kitty/assets/bow.svg', 0.06);
    expect(result).not.toBeNull();
    expect(result!.backgroundImage).toContain('theme-asset://hello-kitty/assets/bow.svg');
    expect(result!.backgroundRepeat).toBe('repeat');
    expect(result!.opacity).toBe('0.06');
  });

  it('returns null when pattern is undefined', () => {
    expect(buildPatternStyle(undefined, 0.06)).toBeNull();
  });
});

describe('computeOverlayTokens — --on-destructive', () => {
  const derive = (destructive?: string) =>
    computeOverlayTokens(TOKENS, undefined, destructive ? { destructive } : undefined, false)[
      '--on-destructive'
    ];

  it('derives white for the default #DD4444 (no visual change from the shipped text-white)', () => {
    // Guards a real spec bug: change 43 was written believing white-on-#DD4444
    // scored 4.7:1 and so specified "white if >= 4.5, else near-black". White
    // actually scores 4.213:1, so that rule would have flipped EVERY danger
    // button to near-black — which is also LOWER contrast (4.131:1). We pick the
    // better of the two instead. If this ever returns #1A1A1A, danger buttons
    // across every built-in theme just silently changed.
    expect(derive()).toBe('#FFFFFF');
  });

  it('derives near-black when a pack overrides destructive with a pale color', () => {
    // The entire point of the token: --destructive is pack-overridable with no
    // contrast guard, so hardcoded white can vanish against a pastel red.
    expect(derive('#FFD1D1')).toBe('#1A1A1A');
    expect(derive('#F8A5A5')).toBe('#1A1A1A');
  });

  it('derives white when a pack overrides destructive with a deep color', () => {
    expect(derive('#7A0000')).toBe('#FFFFFF');
  });

  it('always picks whichever label actually reads better', () => {
    // Property check across the spectrum — never return the worse of the two.
    const lum = (hex: string) => {
      const ch = (i: number) => {
        const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const d of ['#DD4444', '#FFD1D1', '#7A0000', '#C62828', '#FF8080', '#101010']) {
      const picked = derive(d);
      const other = picked === '#FFFFFF' ? '#1A1A1A' : '#FFFFFF';
      expect(ratio(picked, d), `${d} picked ${picked}`).toBeGreaterThanOrEqual(ratio(other, d));
    }
  });
});

describe('computeOverlayTokens — --link / --link-hover', () => {
  const derive = (tokens: typeof TOKENS) =>
    computeOverlayTokens(tokens, undefined, undefined, false);

  it('honors a link declared by the theme instead of deriving one', () => {
    // The four built-ins declare hand-picked links; derivation must not stomp them.
    const result = derive({ ...TOKENS, link: '#2563EB', 'link-hover': '#1D4ED8' } as typeof TOKENS);
    expect(result['--link']).toBe('#2563EB');
    expect(result['--link-hover']).toBe('#1D4ED8');
  });

  it('derives link from accent when accent is far enough from fg', () => {
    // Community packs declare no link and used to inherit :root's #2563EB —
    // light-blue links on every pack regardless of palette.
    expect(derive(TOKENS)['--link']).toBe(TOKENS.accent);
  });

  it('falls back to fg-2 when accent is too close to fg to read as a link', () => {
    // Themes that set accent == fg for high-contrast buttons would otherwise
    // render links invisible against prose. Same guard as --code.
    const flat = { ...TOKENS, accent: TOKENS.fg };
    expect(derive(flat)['--link']).toBe(TOKENS['fg-2']);
  });

  it('derives link-hover as link mixed 85% toward fg', () => {
    expect(derive(TOKENS)['--link-hover']).toBe(
      `color-mix(in oklab, ${TOKENS.accent} 85%, ${TOKENS.fg})`,
    );
  });

  it('never leaves link undefined for any theme', () => {
    // Rule 15: nothing a component consumes may fall back to :root.
    expect(derive(TOKENS)['--link']).toBeTruthy();
    expect(derive(TOKENS)['--link-hover']).toBeTruthy();
  });
});
