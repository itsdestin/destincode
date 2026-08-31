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
      'width var(--dur-reveal) var(--ease-bounce), opacity var(--dur-hover) var(--ease-bounce)',
    );
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
    expect(s.transition).toContain('width var(--dur-reveal) var(--ease-bounce)');
  });
});
