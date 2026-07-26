// @vitest-environment jsdom
// desktop/tests/dialog-shell.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
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

// ── The adoption guard ──────────────────────────────────────────────────────
//
// Source-text, unlike the render assertions above: the failure mode is a future
// session hand-rolling createPortal + Scrim + OverlayPanel in a NEW file, which
// looks fine and only shows up as another bespoke width months later. 49 files
// did exactly that against 7 using the old shell.
//
// Scoped to top-level components/*.tsx -- the settings and status-bar family
// this work is about. Marketplace, project-view, game, git, tags and
// context-menu keep their own overlays for now; they are different surfaces
// with their own visual language and are recorded as tranche-2 residue.

const COMPONENTS = join(__dirname, '..', 'src', 'renderer', 'components');

// Named, with the reason each is NOT a dialog. An exemption you cannot see is
// how the inconsistency this test exists to stop got in.
const NOT_DIALOGS: Record<string, string> = {
  'ResumeBrowser.tsx': 'L1 drawer, not a centered modal',
  'QuickChips.tsx': 'anchored popover positioned against its trigger',
  'SyncPanel.tsx': 'anchored popover positioned against its trigger',
  'ZoomOverlay.tsx': 'L4 system indicator pinned top-right, no scrim dismissal',
};

describe('dialog shell adoption', () => {
  it('no top-level component hand-rolls the shell', () => {
    const offenders = readdirSync(COMPONENTS)
      .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
      .filter((f) => !(f in NOT_DIALOGS))
      .filter((f) => readFileSync(join(COMPONENTS, f), 'utf8').includes('<OverlayPanel'));
    expect(
      offenders,
      'Centered modals go through <Dialog>. It owns scrim, centering, the width '
        + 'ladder, the header and the scroll body — the last of which two of the old '
        + "shell's seven callers got wrong, producing dialogs that clipped with no way to scroll.",
    ).toEqual([]);
  });

  it('every exempted file still exists and still hand-rolls', () => {
    // An exemption is a liability once it stops being true: if one of these is
    // migrated or deleted, this list should shrink rather than quietly rot.
    for (const [file, why] of Object.entries(NOT_DIALOGS)) {
      const src = readFileSync(join(COMPONENTS, file), 'utf8');
      expect(src.includes('<OverlayPanel'), `${file} (${why}) no longer hand-rolls — drop it from NOT_DIALOGS`).toBe(true);
    }
  });
});
