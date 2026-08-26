// @vitest-environment jsdom
// desktop/tests/statusbar-widget-menu.test.tsx
//
// The menu must never offer what the bar refuses to draw, and must never
// explain away a widget that is missing for a different reason (git-branch).
//
// Scaffolding note: the brief's draft uses @testing-library/user-event, which
// is not a dependency of this repo (task 6 hit the same gap — see
// import-file-dialog.test.tsx). Swapped to RTL's own `fireEvent`, this repo's
// existing convention; every assertion below is verbatim from the brief.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import StatusBar from '../src/renderer/components/StatusBar';

// Multiple <StatusBar> renders share one jsdom document in this file — see
// statusbar-session-relevance.test.tsx for why explicit cleanup is required
// here (this repo doesn't enable vitest's `globals`).
afterEach(cleanup);

beforeEach(() => {
  // This repo's jsdom ships no localStorage — stub it the same way
  // statusbar-session-relevance.test.tsx / remote-shim-unsupported.test.ts do.
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  // StatusBar renders SessionTagsChip unconditionally whenever sessionId is
  // set; stub the minimal window.claude surface it reads so mounting doesn't
  // crash — none of these values are under test here.
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});

const statusData = {
  usage: null, updateStatus: null, announcement: null, contextPercent: null,
  gitBranch: null, sessionStats: null, syncWarnings: [],
} as any;

async function openMenu(provider: 'claude' | 'native') {
  render(<StatusBar statusData={statusData} provider={provider} sessionId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: /status bar widgets|customize/i }));
}

describe('Customize Status Bar menu', () => {
  it('explains the subscription rows in a native session', async () => {
    await openMenu('native');
    expect(screen.getAllByText('Claude Code sessions only — see /usage').length).toBe(2);
  });

  it('explains the unmeasured rows', async () => {
    await openMenu('native');
    expect(screen.getAllByText('Not measured in this kind of session yet').length).toBe(2);
  });

  it('leaves Git Branch unexplained — it is a missing feed, not a relevance rule', async () => {
    await openMenu('native');
    const row = screen.getByText('Git Branch').closest('div')!;
    expect(row.textContent).not.toMatch(/only|not measured|no published/i);
  });

  it('explains nothing in a Claude Code session', async () => {
    await openMenu('claude');
    expect(screen.queryByText(/Claude Code sessions only/)).toBeNull();
    expect(screen.queryByText(/Not measured in this kind/)).toBeNull();
  });

  it('dims the row without touching the saved choice', async () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['usage-5h']));
    await openMenu('native');
    expect(JSON.parse(window.localStorage.getItem('youcoded-statusbar-widgets')!)).toContain('usage-5h');
  });
});
