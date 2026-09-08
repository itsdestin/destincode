import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const site = fs.readFileSync(path.resolve(__dirname, '../../docs/index.html'), 'utf8');

describe('landing demo fade', () => {
  it('clears and centers the demo exactly once on wide-screen activation', () => {
    expect(site).toContain('var demoActivated = false');
    expect(site).toContain('function activateDemo(){');
    expect(site).toContain('embedFade = 1; setFadeStop(1);');
    expect(site).toContain("embed.classList.add('interactive')");
    expect(site).toContain("document.querySelector('.hero-app').classList.add('revealed')");
    expect(site).toContain('if (!wideMQ.matches || demoActivated) return;');
    expect(site).toContain("behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'");
    expect(site).toContain('top: scrollY + er.top + er.height / 2 - innerHeight / 2');
  });

  it('uses a named shorter scroll reveal span and retains the safe mask technique', () => {
    expect(site).toContain('var FADE_REVEAL_SPAN = 0.5;');
    expect(site).toContain('var revealSpan = Math.max(120, band * FADE_REVEAL_SPAN);');
    expect(site).toContain('/ revealSpan');
    expect(site).toContain("embed.style.maskComposite = 'intersect'");
    expect(site).not.toContain('.frame.embed{overflow:hidden');
    expect(site).not.toContain('.frame.embed{clip-path:');
  });
});
