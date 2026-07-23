// @vitest-environment jsdom
// desktop/tests/resume-browser-native-picker.test.tsx
// Task 6 — Destin's ruling: native resume ALWAYS offers the provider-scoped
// model selector, pre-filled from lastUsedModel ONLY when it matches a model
// available on THIS device; the selection becomes the binding; Resume never
// launches without one. This file exercises the ResumeBrowser wiring end to
// end (real ResumeBrowser + real NativeModelSelect, window.claude mocked) —
// the same jsdom + window.claude mocking pattern as development-popup.test.tsx.
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ResumeBrowser from '../src/renderer/components/ResumeBrowser';

// jsdom does not implement ResizeObserver; stub it so useScrollFade (the
// session list's scroll-fade hook) can mount without throwing.
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

const CATALOG = [
  { id: 'gpt-5', providerId: 'ulid-openrouter', label: 'GPT-5' },
  { id: 'claude-x', providerId: 'ulid-anthropic', label: 'Claude X' },
];
const PROVIDERS = [
  { id: 'ulid-openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
  { id: 'ulid-anthropic', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true },
];

function nativeRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'native-1',
    name: 'Native Chat',
    projectSlug: 'proj',
    projectPath: '/tmp/proj',
    lastModified: Date.now(),
    size: 100,
    provider: 'native',
    harnessId: 'assistant',
    ...overrides,
  };
}

function ccRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'cc-1',
    name: 'CC Chat',
    projectSlug: 'proj2',
    projectPath: '/tmp/proj2',
    lastModified: Date.now(),
    size: 200,
    provider: 'claude',
    ...overrides,
  };
}

function mockWindowClaude(sessions: any[]) {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(sessions),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: { list: vi.fn().mockResolvedValue([]) },
    providers: {
      catalog: vi.fn().mockResolvedValue(CATALOG),
      list: vi.fn().mockResolvedValue(PROVIDERS),
    },
    on: {},
  };
}

// Expands a row by clicking its name text (handleSelectSession).
async function expandRow(name: string) {
  fireEvent.click(await screen.findByText(name));
}

describe('ResumeBrowser — native resume model selector (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders NativeModelSelect for a native row (search box + grouped models), not the CC model/skip-permissions controls', async () => {
    mockWindowClaude([nativeRow()]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
    await expandRow('Native Chat');

    // NativeModelSelect's search box + both provider groups' models render.
    expect(await screen.findByPlaceholderText('Search models…')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('GPT-5')).toBeInTheDocument();
      expect(screen.getByText('Claude X')).toBeInTheDocument();
    });
    // CC-only controls must NOT appear for a native row.
    expect(screen.queryByText('Skip Permissions')).not.toBeInTheDocument();
  });

  it('prefill match auto-selects the matching model and enables Resume without any click', async () => {
    const onResume = vi.fn();
    mockWindowClaude([nativeRow({
      lastUsedModel: { modelId: 'gpt-5', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    })]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} />);
    await expandRow('Native Chat');
    await screen.findByPlaceholderText('Search models…');

    // Auto-selected: the matching row shows selected (aria-pressed) and Resume enables.
    await waitFor(() => {
      const gpt5 = screen.getByText('GPT-5').closest('button')!;
      expect(gpt5).toHaveAttribute('aria-pressed', 'true');
    });
    const resumeBtn = await screen.findByRole('button', { name: 'Resume Session' });
    await waitFor(() => expect(resumeBtn).not.toBeDisabled());

    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith(
      'native-1', 'proj', '/tmp/proj',
      expect.anything(), expect.anything(), expect.anything(),
      'native',
      { providerId: 'ulid-openrouter', modelId: 'gpt-5' },
    );
  });

  it('prefill miss leaves nothing selected and Resume disabled until a manual pick', async () => {
    const onResume = vi.fn();
    // modelId not present in the catalog at all — never substitute, never error.
    mockWindowClaude([nativeRow({
      lastUsedModel: { modelId: 'gpt-4-nonexistent', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    })]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} />);
    await expandRow('Native Chat');
    await screen.findByPlaceholderText('Search models…');
    await waitFor(() => expect(screen.getByText('GPT-5')).toBeInTheDocument());

    // Nothing pre-selected — Resume stays disabled.
    const resumeBtn = await screen.findByRole('button', { name: 'Resume Session' });
    expect(resumeBtn).toBeDisabled();
    expect(screen.getByText('GPT-5').closest('button')).toHaveAttribute('aria-pressed', 'false');

    // Manual pick enables Resume and flows through onResume as the 8th arg.
    fireEvent.click(screen.getByText('Claude X'));
    await waitFor(() => expect(resumeBtn).not.toBeDisabled());
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith(
      'native-1', 'proj', '/tmp/proj',
      expect.anything(), expect.anything(), expect.anything(),
      'native',
      { providerId: 'ulid-anthropic', modelId: 'claude-x' },
    );
  });

  it('leaves a Claude Code row unaffected: still shows the CC model/skip-permissions row, no NativeModelSelect', async () => {
    mockWindowClaude([ccRow()]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
    await expandRow('CC Chat');

    expect(await screen.findByText('Skip Permissions')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search models…')).not.toBeInTheDocument();
    // CC Resume never gates on a native binding.
    const resumeBtn = screen.getByRole('button', { name: 'Resume Session' });
    expect(resumeBtn).not.toBeDisabled();
  });
});
