// @vitest-environment jsdom
// Pins the three scan-badge states and their hover explanations.
//
// WHY this test exists: Destin settled on 2026-08-30 that the grey "Not
// checked" shield STAYS (it is expected to sit on roughly half the catalog),
// which only works if the badge earns its space — its hover text has to tell
// the user what to DO about it, not just name a state. That sentence is the
// whole point of the badge, so it is pinned here rather than left to drift.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ScanBadge, scanExplainer, SCAN_LABEL } from '../src/renderer/components/marketplace/TrustBadges';

afterEach(cleanup);

describe('ScanBadge', () => {
  it('renders one badge per status with its own label', () => {
    expect(SCAN_LABEL.checked).toBe('Likely safe');
    expect(SCAN_LABEL.caution).toBe('Caution');
    expect(SCAN_LABEL.unchecked).toBe('Not checked');
  });

  it('puts the explanation on hover, keyed to the status', () => {
    const { container } = render(<ScanBadge scan={{ status: 'unchecked' }} />);
    const badge = container.querySelector('[data-scan="unchecked"]')!;
    expect(badge.getAttribute('title')).toBe(scanExplainer({ status: 'unchecked' }));
    expect(screen.getByText('Not checked')).toBeInTheDocument();
  });

  it('counts the findings in the caution label', () => {
    render(<ScanBadge scan={{ status: 'caution', findings: ['a', 'b'] }} />);
    expect(screen.getByText('Caution 2')).toBeInTheDocument();
  });

  it('the unchecked explanation tells the user what to do about it', () => {
    const text = scanExplainer({ status: 'unchecked' });
    // Names the two things a user can actually check for themselves.
    expect(text).toMatch(/What this can do/);
    expect(text).toMatch(/source/i);
    // …and says it before the install, which is the only moment it helps.
    expect(text).toMatch(/install/i);
    // One sentence — a paragraph in a tooltip does not get read.
    expect(text.split('.').filter((s) => s.trim()).length).toBe(1);
  });

  it('never claims a check that did not happen', () => {
    expect(scanExplainer({ status: 'checked' })).toMatch(/read every file/i);
    expect(scanExplainer({ status: 'unchecked' })).not.toMatch(/found nothing/i);
  });
});
