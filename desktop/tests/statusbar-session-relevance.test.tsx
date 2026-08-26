// @vitest-environment jsdom
// desktop/tests/statusbar-session-relevance.test.tsx
//
// The bar must not render another runtime's furniture. 5h/7d describe a Claude
// subscription a native session doesn't spend; Fast mode is a Claude Code
// toggle nothing native honours (spec §3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import StatusBar from '../src/renderer/components/StatusBar';
import { emptyTotals } from '../src/renderer/state/session-totals';

// Multiple <StatusBar> renders share one jsdom document in this file — without
// explicit cleanup a later test's queryByText/getByText would see the
// previous test's DOM too (this repo doesn't enable vitest's `globals`, so
// Testing Library's implicit afterEach cleanup never registers).
afterEach(cleanup);

beforeEach(() => {
  // This repo's jsdom ships no localStorage (Node's experimental global
  // storage needs --localstorage-file, which isn't passed) — stub it the same
  // way tests/remote-shim-unsupported.test.ts does.
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  // StatusBar renders SessionTagsChip unconditionally whenever sessionId is
  // set; that chip reads the tag registry and session meta over
  // window.claude. Stub the minimal surface so mounting it doesn't crash in
  // this DOM-only harness — none of these values are under test here.
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});

const statusData = {
  usage: {
    five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3.6e6).toISOString() },
    seven_day: { utilization: 17, resets_at: new Date(Date.now() + 8.6e7).toISOString() },
  },
  updateStatus: null,
  announcement: null,
  contextPercent: null,
  gitBranch: null,
  sessionStats: null,
  syncWarnings: [],
} as any;

describe('StatusBar runtime relevance', () => {
  it('shows the subscription chips and the Fast chip in a Claude Code session', () => {
    render(<StatusBar statusData={statusData} provider="claude" fast sessionId="s1" />);
    expect(screen.getByText('5h:')).toBeInTheDocument();
    expect(screen.getByText('7d:')).toBeInTheDocument();
    // The Fast chip is icon-only (FastIcon, no text node) — its only
    // accessible name is aria-label="Fast mode on", so getByText can never
    // find it regardless of the runtime gate. getByRole reads the computed
    // accessible name instead.
    expect(screen.getByRole('button', { name: /fast/i })).toBeInTheDocument();
  });

  it('renders none of them in a native session', () => {
    render(<StatusBar statusData={statusData} provider="native" fast sessionId="s1" />);
    expect(screen.queryByText('5h:')).toBeNull();
    expect(screen.queryByText('7d:')).toBeNull();
    expect(screen.queryByRole('button', { name: /fast/i })).toBeNull();
    // Positive control: an assertion that only checks absences would also pass
    // if the whole bar failed to render. SessionTagsChip renders for ANY
    // runtime whenever sessionId is set (verified against its source: the only
    // gate is `!isAndroid()`) and shows "Add tags" synchronously — before the
    // stubbed getMeta() promise resolves — since useSessionMeta initializes
    // tags/note empty. Its presence here proves the bar actually mounted.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('treats an unwired provider as Claude Code, so nothing hides by accident', () => {
    render(<StatusBar statusData={statusData} fast sessionId="s1" />);
    expect(screen.getByText('5h:')).toBeInTheDocument();
  });
});

describe('StatusBar renders no empty chips', () => {
  // Rule 1 (spec §3): a chip with no value hides. Verified today: Session
  // Duration (StatusBar.tsx:1289) and Active Ratio (:1377) both print a literal
  // '--' in every native session, forever, and the token/speed chips do the same
  // before their first turn.
  const widgets = ['session-time', 'active-ratio', 'tokens-in', 'tokens-out', 'output-speed', 'cache-stats', 'cache-hit-rate'];

  it('renders no "--" anywhere in a native session with no data', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(widgets));
    const { container } = render(<StatusBar statusData={statusData} provider="native" sessionId="s1" />);
    expect(container.textContent).not.toContain('--');
    // Positive control (see the runtime-relevance describe above for why):
    // proves this render actually mounted the bar rather than the assertion
    // above passing vacuously on an empty container.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('renders no "--" in a Claude Code session whose stats have not arrived yet', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(widgets));
    const { container } = render(<StatusBar statusData={statusData} provider="claude" sessionId="s1" />);
    expect(container.textContent).not.toContain('--');
    // Positive control, same reasoning as above.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('still renders the chip once it has a value', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['active-ratio']));
    const withStats = { ...statusData, sessionStats: { duration: 1000, apiDuration: 250 } };
    render(<StatusBar statusData={withStats} provider="claude" sessionId="s1" />);
    expect(screen.getByText('25%')).toBeInTheDocument();
  });
});

const withWidgets = (ids: string[]) =>
  window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(ids));

describe('StatusBar session totals', () => {
  it('renders cumulative In/Out from totals in a native session', () => {
    withWidgets(['tokens-in', 'tokens-out']);
    const totals = { ...emptyTotals(), inputTokens: 12_345, outputTokens: 678 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('678')).toBeInTheDocument();
  });

  it('renders a derived Code Changes count in a native session', () => {
    withWidgets(['code-changes']);
    const totals = { ...emptyTotals(), linesAdded: 40, linesRemoved: 9 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(screen.getByText('+40')).toBeInTheDocument();
    expect(screen.getByText('-9')).toBeInTheDocument();
  });

  it('renders NOTHING for Code Changes when nothing has been edited — never "No changes"', () => {
    withWidgets(['code-changes']);
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={emptyTotals()} sessionId="s1" />);
    expect(screen.queryByText(/no changes/i)).toBeNull();
    expect(screen.queryByText(/lines/i)).toBeNull();
  });

  it('says what the numbers include', () => {
    withWidgets(['tokens-in']);
    const totals = { ...emptyTotals(), inputTokens: 10, specialistRuns: 2 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(screen.getByTitle(/including specialists/i)).toBeInTheDocument();
  });
});
