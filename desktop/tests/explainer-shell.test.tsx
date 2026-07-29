// @vitest-environment jsdom
// desktop/tests/explainer-shell.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import SettingsExplainer from '../src/renderer/components/SettingsExplainer';
import { stripComments } from './helpers/guard-scope';

// Guard for K12 — the explainer renders a payload, and nothing else.
//
// The spec framed K12 as consolidating five mechanisms into one renderer. By
// the time tranche 3 started that had already happened: four hosts shared this
// component and the same {intro, sections} payload. What had NOT happened is
// that this component predates <Dialog> and hand-rolled the header, the scroll
// body and the Esc handler — the exact three things D1 was built to own, and
// the same "the caller must remember to wrap it" shape that let two of
// SettingsPopup's seven callers ship dialogs that could not scroll.

afterEach(cleanup);

const SECTIONS = [
  { heading: 'What it does', paragraphs: ['It explains things.'] },
  { heading: 'Bullets', bullets: [{ term: 'Term', text: 'body text' }] },
];

describe('SettingsExplainer', () => {
  it('renders the payload', () => {
    render(<SettingsExplainer intro="An intro." sections={SECTIONS} />);
    expect(screen.getByText('An intro.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What it does' })).toBeInTheDocument();
    expect(screen.getByText('It explains things.')).toBeInTheDocument();
    expect(screen.getByText('Term')).toBeInTheDocument();
  });

  it('section headings are h3, matching K1', () => {
    // The dialog title is h2, so an explainer heading must be h3 or it announces
    // as a sibling of the dialog's own name rather than as its child.
    render(<SettingsExplainer intro="i" sections={SECTIONS} />);
    expect(screen.getByRole('heading', { name: 'What it does' }).tagName).toBe('H3');
  });

  it('owns no dialog chrome', () => {
    render(<SettingsExplainer intro="i" sections={SECTIONS} />);
    expect(screen.queryByRole('heading', { level: 2 }), 'the header belongs to Dialog').toBeNull();
    expect(screen.queryByRole('button', { name: /close/i }), 'close belongs to Dialog').toBeNull();
    expect(screen.queryByRole('button', { name: /back/i }), 'back belongs to Dialog').toBeNull();
    expect(document.querySelector('.scroll-fade'), 'the scroll body belongs to Dialog').toBeNull();
  });
});

describe('explainer hosts', () => {
  const COMPONENTS = join(__dirname, '..', 'src', 'renderer', 'components');
  // Every file that renders <SettingsExplainer>. ThemeScreen is the odd one: it
  // fills a Dialog it does not own, so its `showInfo` is LIFTED to SettingsPanel
  // and passed back down — which is why SettingsPanel appears here twice over
  // (Remote Access owns its Dialog directly; Appearance owns ThemeScreen's).
  const HOSTS = ['ContextPopup.tsx', 'ThemeScreen.tsx', 'SettingsPanel.tsx', 'SyncPanel.tsx'];

  it('no host passes the explainer chrome props it no longer has', () => {
    // title/onBack/onClose moved to <Dialog>. A host still passing them would be
    // a type error today, but this pins the INTENT so a future `...rest` spread
    // on the component cannot quietly reintroduce them.
    const offenders: string[] = [];
    for (const host of HOSTS) {
      const src = stripComments(readFileSync(join(COMPONENTS, host), 'utf8'));
      for (const m of src.matchAll(/<SettingsExplainer[\s\S]{0,400}?\/>/g)) {
        if (/\b(title|onBack|onClose)=/.test(m[0])) offenders.push(host);
      }
    }
    expect(offenders, 'Dialog owns title, back and close — the explainer takes only its payload.').toEqual([]);
  });

  it('every host drives Dialog onBack from its showInfo flag', () => {
    // The affordance has to come from somewhere. Dialog gained `onBack` in
    // tranche 2 for exactly this and nothing used it until now; if a host stops
    // passing it, the explainer becomes a view you cannot back out of.
    const offenders: string[] = [];
    for (const host of HOSTS) {
      const src = stripComments(readFileSync(join(COMPONENTS, host), 'utf8'));
      if (!src.includes('<SettingsExplainer')) continue;
      // ThemeScreen is the lifted case — its host wires onBack, not it.
      if (host === 'ThemeScreen.tsx') {
        if (!/showInfo/.test(src)) offenders.push(`${host} (expected a lifted showInfo prop)`);
        continue;
      }
      // Match the INTENT, not the formatting. Two earlier versions of this got
      // it wrong in opposite directions: `onBack={showInfo` failed once
      // SyncPanel's became a multi-line ternary (four views share that Dialog
      // now), and requiring a newline before the closing brace then failed on
      // the hosts that fit on one line. Extract every onBack expression by
      // BALANCING BRACES and require that one of them consults showInfo —
      // SettingsPanel legitimately has a second onBack for Account's
      // connections sub-page, which has nothing to do with the explainer.
      const expressions: string[] = [];
      for (const m of src.matchAll(/onBack=\{/g)) {
        let depth = 1;
        let i = m.index! + m[0].length;
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        expressions.push(src.slice(m.index!, i));
      }
      if (!expressions.some((e) => e.includes('showInfo'))) offenders.push(host);
    }
    expect(offenders, 'Pass onBack to <Dialog>, gated on showInfo.').toEqual([]);
  });
});
