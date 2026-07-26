// @vitest-environment jsdom
// desktop/tests/dialog-shell.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Dialog, DIALOG_WIDTHS } from '../src/renderer/components/ui/Dialog';

// Guard for D1 — the one dialog shell.
//
// This is a RENDER test, unlike the other authority tests, because the defect it
// exists to stop is structural rather than textual. SettingsPopup (the shell this
// replaces) set maxHeight on the panel but left the panel a plain block, so every
// caller had to remember `className="flex flex-col"` and wrap its own scroll-fade
// body. TWO OF ITS SEVEN CALLERS FORGOT -- Sound and Session Defaults -- and the
// symptom is a dialog that silently clips its content with no way to scroll to the
// bottom. Destin hit it in the Sound popup on 2026-07-26.
//
// A shell that 2/7 of its own callers can hold wrong is not a shell. The whole
// point of Dialog is that the scroll body is not the caller's job, so that is
// what these assertions pin: you cannot get a Dialog whose body does not scroll.

afterEach(cleanup);

// jsdom does not implement ResizeObserver; Dialog's scroll body runs
// useScrollFade, which observes its own size. Same stub the other overlay
// render tests use (context-popup, resume-browser-native-picker).
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// createPortal renders into document.body; query from there.
function panel(): HTMLElement {
  const el = document.querySelector('[data-layer="2"].layer-surface');
  if (!el) throw new Error('no dialog panel rendered');
  return el as HTMLElement;
}

describe('Dialog shell', () => {
  it('renders nothing when closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="Nope">body</Dialog>);
    expect(document.querySelector('.layer-surface')).toBeNull();
  });

  it('the panel is a flex column so its body can be bounded', () => {
    // This is the exact property SettingsPopup left to the caller.
    render(<Dialog open onClose={() => {}} title="Sound">body</Dialog>);
    expect(panel().className).toContain('flex');
    expect(panel().className).toContain('flex-col');
  });

  it('owns a scrolling body — the caller does not supply one', () => {
    render(<Dialog open onClose={() => {}} title="Sound"><p>tall</p></Dialog>);
    const body = panel().querySelector('.scroll-fade');
    expect(body, 'Dialog must render its own scroll region').not.toBeNull();
    // flex-1 is what gives the scroll region a bounded height inside the column.
    // Without it the body grows to fit content and overflow never engages.
    expect(body!.className).toContain('flex-1');
  });

  it('scrollBody={false} lets a caller own its whole surface', () => {
    // Appearance hands the panel to ThemeScreen; Remote Access swaps in
    // SettingsExplainer. Those own their own scroll regions.
    render(<Dialog open onClose={() => {}} scrollBody={false}><p>custom</p></Dialog>);
    expect(panel().querySelector('.scroll-fade')).toBeNull();
  });

  it('a titled dialog gets an h2 and a close button', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Sound &amp; Notifications">body</Dialog>);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toBeInTheDocument();
    // h2, not h3: section labels inside the body are h3 (K1), so a h3 title
    // would make them siblings of the dialog's own name.
    expect(heading.tagName).toBe('H2');
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('exposes exactly the four width rungs', () => {
    // No bespoke widths. 18 distinct ones shipped before this.
    expect(Object.keys(DIALOG_WIDTHS).sort()).toEqual(['lg', 'md', 'sm', 'xl']);
    expect(DIALOG_WIDTHS).toEqual({
      sm: 'min(340px, 88vw)',
      md: 'min(420px, 88vw)',
      lg: 'min(560px, 88vw)',
      xl: 'min(820px, 88vw)',
    });
  });

  it('height is a ceiling, never fixed', () => {
    // A fixed `h-` is what makes ContextPopup jump to full height when its
    // explainer opens. Dialog makes it inexpressible: there is only maxHeight.
    render(<Dialog open onClose={() => {}} title="X">body</Dialog>);
    expect(panel().style.maxHeight).toBe('80vh');
    expect(panel().style.height).toBe('');
  });
});
