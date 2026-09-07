// @vitest-environment jsdom
/**
 * The red "needs attention" dot on Settings → Assistant settings.
 *
 * Design review 1, R1-5: the dot was permanently ON for every Android install.
 * Android answers `engine:status` honestly with
 * `{ ok: false, error: 'not-implemented-on-mobile' }`, and the hook read any
 * `error` field as trouble — so every phone showed a red dot pointing at a
 * Local models page Android does not have, with no way to clear it.
 *
 * A dot that cannot be cleared is worse than no dot: it is the one signal this
 * row has, and it only works if it is rare and true.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AssistantSettingsRow from '../src/renderer/components/assistant-settings/AssistantSettings';

const DEFAULTS = { skipPermissions: false, model: 'sonnet', projectFolder: '' };

function stub(claude: Record<string, unknown>) {
  (window as any).claude = {
    providers: { list: async () => [], catalog: async () => [] },
    models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
    on: { statusData: () => () => {} },
    off: () => {},
    firstRun: { getState: async () => ({ authMode: 'oauth', currentStep: 'COMPLETE' }) },
    search: { list: async () => [] },
    folders: { list: async () => [] },
    shell: { openExternal: () => {} },
    syncSpaces: { onEvent: () => () => {} },
    ...claude,
  };
}

const row = () => render(<AssistantSettingsRow defaults={DEFAULTS} onDefaultsChange={() => {}} />);
const dot = () => screen.queryByRole('img', { name: 'A provider needs attention' });

describe('Assistant settings — the attention dot', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('stays off where there is no native runtime, whatever engine:status answers', async () => {
    // Android's real reply. `ok: false` means the question could not be asked.
    stub({
      native: { supported: false },
      engine: { status: async () => ({ ok: false, error: 'not-implemented-on-mobile' }) },
    });
    row();
    await waitFor(() => expect(screen.getByText('Assistant settings')).toBeInTheDocument());
    expect(dot()).toBeNull();
  });

  it('stays off for a transport failure on desktop — that is not a failed engine', async () => {
    stub({
      native: { supported: true },
      engine: { status: async () => ({ ok: false, error: 'bridge closed' }) },
      chatgpt: { supported: true, status: async () => ({ state: 'signed-out' }) },
    });
    row();
    await waitFor(() => expect(screen.getByText('Assistant settings')).toBeInTheDocument());
    expect(dot()).toBeNull();
  });

  it('comes on for an engine that actually failed to start', async () => {
    stub({
      native: { supported: true },
      engine: { status: async () => ({ state: 'error' }) },
      chatgpt: { supported: true, status: async () => ({ state: 'signed-out' }) },
    });
    row();
    expect(await screen.findByRole('img', { name: 'A provider needs attention' })).toBeInTheDocument();
  });

  it('comes on for a ChatGPT plan the provider has blocked', async () => {
    stub({
      native: { supported: true },
      engine: { status: async () => ({ state: 'ready' }) },
      chatgpt: { supported: true, status: async () => ({ state: 'blocked', email: 'd@example.com', reason: 'no' }) },
    });
    row();
    expect(await screen.findByRole('img', { name: 'A provider needs attention' })).toBeInTheDocument();
  });
});
