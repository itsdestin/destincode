// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeRigSvg } from '../src/renderer/components/mascot/sanitize-rig-svg';

const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -5 30 30">${inner}</svg>`;

describe('sanitizeRigSvg', () => {
  it('returns null for non-SVG and unparseable input', () => {
    expect(sanitizeRigSvg('<div>nope</div>')).toBeNull();
    expect(sanitizeRigSvg('<<<garbage')).toBeNull();
  });

  it('preserves rig groups, data-pivot, and shapes', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-arm-left" data-pivot="2.5 9"><rect x="1" y="2" width="3" height="4"/></g>'));
    expect(out).toContain('rig-arm-left');
    expect(out).toContain('data-pivot="2.5 9"');
    expect(out).toContain('<rect');
  });

  it('strips script, foreignObject, and style tags', () => {
    const out = sanitizeRigSvg(wrap('<script>alert(1)</script><foreignObject><body/></foreignObject><style>@import url(http://evil)</style><g id="rig-body"/>'));
    expect(out).not.toContain('script');
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('style>');
    expect(out).toContain('rig-body');
  });

  it('strips SMIL animation tags (all animation is app-side)', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-body"><animate attributeName="x" from="0" to="9"/><animateTransform attributeName="transform"/></g>'));
    expect(out).not.toContain('<animate');
    expect(out).toContain('rig-body');
  });

  it('strips on* event handler attributes', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-body" onclick="evil()" onload="evil()"/>'));
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onload');
  });

  it('strips external hrefs but keeps same-document refs and data: images', () => {
    const out = sanitizeRigSvg(wrap(
      '<use href="#part"/><image href="data:image/png;base64,AAAA"/><image href="https://evil.example/x.png"/>'
    ));
    expect(out).toContain('href="#part"');
    expect(out).toContain('data:image/png');
    expect(out).not.toContain('evil.example');
  });

  it('strips style attributes containing external url()', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-body" style="fill: url(http://evil.example/f.svg#x)"/>'));
    expect(out).not.toContain('evil.example');
  });

  it('keeps benign style attributes (display:none face groups, var() tints)', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-face-blink" style="display:none"><path d="M1 1h2"/></g>'));
    expect(out).toContain('display:none');
    const tinted = sanitizeRigSvg(wrap('<stop style="stop-color:var(--rig-accent, #f0a828)"/>'));
    expect(tinted).toContain('--rig-accent');
  });

  it('keeps gradients, filters, and internal url(#ref) paints', () => {
    const out = sanitizeRigSvg(wrap(
      '<defs><radialGradient id="g-hi"><stop offset="0"/></radialGradient></defs><g id="rig-body"><path d="M1 1h2" fill="url(#g-hi)"/></g>'
    ));
    expect(out).toContain('radialGradient');
    expect(out).toContain('url(#g-hi)');
  });
});
