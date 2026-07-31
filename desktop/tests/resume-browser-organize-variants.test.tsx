// @vitest-environment jsdom
// desktop/tests/resume-browser-organize-variants.test.tsx
//
// Three candidate designs for where a conversation's flags/tags/note live are
// under comparison in the workbench (utils/design-variant.ts + the toolbar's
// "Organize UI" switcher). Two of them are branches the shipping default never
// renders, so nothing else in the suite would execute them — a JSX or wiring
// error in 'tabs' or 'inline' would sit undetected until someone flipped the
// switch. This file mounts all three and asserts each one can actually reach
// the same three controls, because "the alternatives are equivalent in what
// they can do" is the premise the comparison rests on.
//
// Delete this file when a winner is picked and the losing branches go.
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Controllable stand-in for the query-string read. The real module resolves the
// variant once at load, which a test cannot re-drive per case.
let variant = 'popover';
vi.mock('../src/renderer/utils/design-variant', () => ({
  designVariant: () => variant,
}));

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

function mockWindowClaude() {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue([{
        sessionId: 'cc-1',
        name: 'CC Chat',
        projectSlug: 'proj',
        projectPath: '/tmp/proj',
        lastModified: Date.now(),
        size: 200,
        provider: 'claude',
      }]),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: { list: vi.fn().mockResolvedValue(TAGS) },
    providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
    on: {},
  };
}

// Opens whatever this variant's route to the organize controls is.
async function reachOrganize(v: string) {
  if (v === 'popover') {
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    return;
  }
  fireEvent.click(await screen.findByText('CC Chat'));            // expand the card
  if (v === 'tabs') fireEvent.click(await screen.findByRole('tab', { name: 'Organize' }));
  if (v === 'inline') fireEvent.click(await screen.findByRole('button', { name: '+ Tag' }));
}

describe('ResumeBrowser — organize-UI variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindowClaude();
  });

  for (const v of ['popover', 'tabs', 'inline'] as const) {
    it(`'${v}' reaches the tag picker`, async () => {
      variant = v;
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
      await reachOrganize(v);
      // Every variant routes to the SAME TagPicker, so this is the one assertion
      // that holds across all three.
      expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
    });

    it(`'${v}' can toggle Priority`, async () => {
      variant = v;
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
      // 'inline' shows flags as chips in the expanded card, not behind the
      // "+ Tag" popover — expanding is enough.
      if (v === 'inline') fireEvent.click(await screen.findByText('CC Chat'));
      else await reachOrganize(v);
      // 'popover'/'tabs' render the flag row with a trailing hint ("pins to
      // top"), which lands in the accessible name — anchor the match instead.
      fireEvent.click(await screen.findByRole('button', { name: /^Priority/ }));
      expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'priority', true);
    });
  }

  it("'popover' can organize a row that cannot be resumed on this device", async () => {
    // The reach the other two variants give up: an inert row never expands, so
    // a design that lives inside the expanded card cannot tag it at all.
    variant = 'popover';
    (window as any).claude.session.browse = vi.fn().mockResolvedValue([{
      sessionId: 'cc-2',
      name: 'Synced Elsewhere',
      projectSlug: 'proj',
      projectPath: '/tmp/proj',
      lastModified: Date.now(),
      size: 10,
      provider: 'claude',
      missingProject: true,
    }]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Organize Synced Elsewhere/ }));
    expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
  });
});
