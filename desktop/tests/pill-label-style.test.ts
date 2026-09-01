import { describe, it, expect } from 'vitest';
import { pillLabelStyle, HOVER_CAP_PX } from '../src/renderer/components/header/pill-label-style';

const base = { showName: false, isActive: false, packExpanded: false, animateExpand: false };

describe('pillLabelStyle', () => {
  it('collapses to zero width when the name is hidden', () => {
    const s = pillLabelStyle(base);
    expect(s.width).toBe('0px');
    expect(s.opacity).toBe(0);
  });

  it('reveals a non-active pill to its OWN width, capped', () => {
    // The 2026-08-31 bug: the old code animated to a flat 120px, so a short
    // name reached full size early and then sat still while the transition
    // kept running. calc-size() interpolates to the label's real width.
    const s = pillLabelStyle({ ...base, showName: true });
    expect(s.width).toBe(`calc-size(max-content, min(size, ${HOVER_CAP_PX}px))`);
  });

  it('reveals the active pill uncapped so it can hold a long name', () => {
    const s = pillLabelStyle({ ...base, showName: true, isActive: true });
    expect(s.width).toBe('calc-size(max-content, size)');
  });

  it('animates on the vocabulary, not two different curves', () => {
    const s = pillLabelStyle({ ...base, showName: true });
    expect(s.transition).toBe(
      'width var(--dur-reveal) var(--ease-out), opacity var(--dur-hover) var(--ease-out)',
    );
  });

  it('does NOT cap a pill the packer chose to expand', () => {
    // RC1 (2026-08-31, measured): the 120px cap is the HOVER reveal budget —
    // a peek at a name you are pointing at. It was applied to every non-active
    // pill, so a pill the packer had measured full room for still clipped its
    // name at exactly 120px while its runtime badge kept 96px beside it.
    const s = pillLabelStyle({ ...base, showName: true, packExpanded: true });
    expect(s.width).toBe('calc-size(max-content, size)');
  });

  it('still caps a pill that is only showing its name because of hover', () => {
    const s = pillLabelStyle({ ...base, showName: true });
    expect(s.width).toBe(`calc-size(max-content, min(size, ${HOVER_CAP_PX}px))`);
  });

  it('never animates width on an overshoot curve', () => {
    // RC3 (2026-08-31, measured): width is a LAYOUT property — every sibling
    // re-lays-out on every frame of it. An overshoot curve therefore sends the
    // whole row past its destination and back: one click moved the active pill
    // 202.5 -> 261.9 -> 251.3 and every pill right of it 515.5 -> 583.4 -> 578.4.
    // Overshoot belongs on transform, which moves nothing but itself.
    for (const input of [
      { ...base, showName: true },
      { ...base, showName: true, isActive: true },
      { ...base, showName: true, isActive: true, packExpanded: true, animateExpand: true },
    ]) {
      const t = pillLabelStyle(input).transition ?? '';
      const widthPart = t.split(',').find(p => p.trim().startsWith('width')) ?? '';
      expect(widthPart).not.toContain('--ease-bounce');
    }
  });

  it('kills the transition for a pack-expanded pill (repack churn)', () => {
    // The `none` exists so pills do not slide around every time the packer
    // runs. It stays.
    const s = pillLabelStyle({ ...base, showName: true, packExpanded: true });
    expect(s.transition).toBe('none');
  });

  it('overrides that kill-switch inside the armed window after a click', () => {
    // packSessions guarantees the ACTIVE pill is always pack-expanded, so
    // without this override the transition is off for exactly the pill the
    // user just clicked — cause #2 of the snap.
    const s = pillLabelStyle({
      ...base, showName: true, isActive: true, packExpanded: true, animateExpand: true,
    });
    expect(s.transition).toContain('width var(--dur-reveal) var(--ease-out)');
  });
});
