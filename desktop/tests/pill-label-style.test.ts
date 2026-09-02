import { describe, it, expect } from 'vitest';
import {
  pillLabelStyle, labelTargetWidth, HOVER_CAP_PX, LABEL_TAIL_PX, LABEL_SLACK_PX,
} from '../src/renderer/components/header/pill-label-style';

const base = { showName: false, isActive: false, packExpanded: false, animateExpand: false, nameWidth: 80 };

describe('pillLabelStyle', () => {
  it('collapses to zero when the name is hidden', () => {
    const s = pillLabelStyle(base);
    expect(s.maxWidth).toBe('0px');
    expect(s.opacity).toBe(0);
  });

  it('opens a hover peek to the name\'s OWN width plus its fade tail', () => {
    // Every name used to open the same fixed distance, so a short one finished
    // early and then sat still while the animation kept going.
    const s = pillLabelStyle({ ...base, showName: true });
    expect(s.maxWidth).toBe(`${80 + LABEL_TAIL_PX + LABEL_SLACK_PX}px`);
    expect(s.opacity).toBe(1);
  });

  it('caps a hover peek, because a peek must not shove the row around', () => {
    expect(labelTargetWidth({ isActive: false, packExpanded: false, nameWidth: 300 })).toBe(HOVER_CAP_PX);
  });

  it('does NOT cap the active pill or one the packer chose to expand', () => {
    // The packer measured the room a full name needs before expanding it.
    expect(labelTargetWidth({ isActive: true, packExpanded: false, nameWidth: 300 })).toBe(300 + LABEL_TAIL_PX + LABEL_SLACK_PX);
    expect(labelTargetWidth({ isActive: false, packExpanded: true, nameWidth: 300 })).toBe(300 + LABEL_TAIL_PX + LABEL_SLACK_PX);
  });

  it('always hands the browser a NUMBER at both ends', () => {
    // The original snap: `maxWidth: undefined` on exactly the pill that had
    // just become active, so there was nothing to interpolate towards.
    for (const isActive of [true, false]) {
      for (const packExpanded of [true, false]) {
        const s = pillLabelStyle({ ...base, showName: true, isActive, packExpanded });
        expect(s.maxWidth).toMatch(/^\d+px$/);
      }
    }
    expect(pillLabelStyle({ ...base, nameWidth: 80.4, showName: true }).maxWidth).toBe(`${81 + LABEL_TAIL_PX + LABEL_SLACK_PX}px`);
  });

  it('animates on the vocabulary, one curve for both properties', () => {
    const s = pillLabelStyle({ ...base, showName: true });
    expect(s.transition).toBe(
      'max-width var(--dur-reveal) var(--ease-reveal), opacity var(--dur-hover) var(--ease-reveal)',
    );
  });

  it('never animates width on an overshoot curve', () => {
    // max-width is a layout property: every sibling re-lays-out on every frame
    // of it, so an overshoot sends the whole row past its destination and back.
    for (const packExpanded of [true, false]) {
      const t = String(pillLabelStyle({ ...base, showName: true, packExpanded, animateExpand: true }).transition);
      const widthPart = t.split(',').find(p => p.trim().startsWith('max-width')) ?? '';
      expect(widthPart).not.toMatch(/bounce|spring/);
      expect(widthPart).toMatch(/--ease-reveal/);
    }
  });

  it('kills the transition for a pack-expanded pill (repack churn)', () => {
    // The `none` exists so pills do not slide around every time the packer
    // runs. It stays.
    const s = pillLabelStyle({ ...base, showName: true, packExpanded: true });
    expect(s.transition).toBe('none');
  });

  it('overrides that kill-switch inside the armed window after a click', () => {
    // packSessions guarantees the active pill is ALWAYS pack-expanded, so
    // without this the one pill the user just clicked would be the one pill
    // that never animates.
    const s = pillLabelStyle({ ...base, showName: true, isActive: true, packExpanded: true, animateExpand: true });
    expect(s.transition).not.toBe('none');
  });
});
