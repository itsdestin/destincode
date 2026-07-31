// @vitest-environment jsdom
// desktop/tests/resume-browser-organize.test.tsx
//
// The Resume Browser's per-card organize affordances: the hide (Complete) icon
// on the card, and the "⋯" popover holding tags + note. Three of these
// behaviours are design decisions that are easy to undo by accident, so they
// are pinned here rather than left to a visual pass:
//
//   1. Complete is reachable in ONE click from the card, not behind the menu.
//   2. Priority is applied through the tag picker like any other tag, but is
//      not a registry tag — toggling it writes a FLAG, and it never appears in
//      the tag manager (so it can't be renamed or deleted out from under the
//      sort that reads it).
//   3. A row that cannot be resumed on this device can still be organized.
//      Inert rows never expand, so anything living inside the expanded card
//      would be unreachable for them.
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ResumeBrowser from '../src/renderer/components/ResumeBrowser';

beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

const TAGS = [{ id: 'tag_a', label: 'Research', color: 'tag-blue', archived: false, createdAt: '' }];

function row(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'cc-1',
    name: 'CC Chat',
    projectSlug: 'proj',
    projectPath: '/tmp/proj',
    lastModified: Date.now(),
    size: 200,
    provider: 'claude',
    ...overrides,
  };
}

function mockWindowClaude(sessions: any[] = [row()]) {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(sessions),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: {
      list: vi.fn().mockResolvedValue(TAGS),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
    on: {},
  };
}

const mount = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);

describe('ResumeBrowser — organizing a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindowClaude();
  });

  it('marks a session complete from the card, without opening the menu', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark CC Chat complete' }));
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'complete', true);
  });

  it('offers to undo once complete', async () => {
    mockWindowClaude([row({ flags: { complete: true } })]);
    mount();
    // Complete rows are filtered out by default — turn Show Complete on so the
    // row is listed, then assert the icon has flipped to its undo affordance.
    fireEvent.click(await screen.findByRole('switch', { name: 'Show Complete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark CC Chat not complete' }));
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'complete', false);
  });

  it('applies Priority through the tag picker but writes a flag, not a tag', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    // Listed among the tags, ahead of the registry ones.
    fireEvent.click(await screen.findByRole('button', { name: /^Priority/ }));
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'priority', true);
    expect((window as any).claude.session.setTag).not.toHaveBeenCalled();
  });

  it('keeps the "pins to top" explanation next to Priority', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    expect(await screen.findByText('pins to top')).toBeInTheDocument();
  });

  it('does not offer Priority for renaming or deletion in the tag manager', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    fireEvent.click(await screen.findByText('Manage tags…'));
    // The registry tag is editable there; the built-in has no row at all.
    expect(await screen.findByRole('textbox', { name: 'Rename Research' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Rename Priority' })).not.toBeInTheDocument();
  });

  it('organizes a row that cannot be resumed on this device', async () => {
    mockWindowClaude([row({ sessionId: 'cc-2', name: 'Synced Elsewhere', missingProject: true })]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize Synced Elsewhere/ }));
    expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
  });
});
