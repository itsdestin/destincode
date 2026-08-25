// @vitest-environment jsdom
// Pins the D4-unlock safety behavior of ActiveArtifactView (plan step 4):
// 1. THE §2.2 EMPTY-FILE GUARANTEE — while content is null (fetch transient /
//    orphan / binary) a save must be hard-blocked: both hosts setContent(null)
//    before the get resolves, and a save in that window would truncate the
//    file to an empty draft. This is the highest-risk regression in the
//    workstream; if this test starts failing, do not ship.
// 2. The renderer's D5 mirror hides editability for denied paths.
// 3. dirty only when edit mode holds real divergence from resolved content.
// 4. The concurrency token from startEdit's refresh rides into the save.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../src/renderer/components/artifact-views/ActiveArtifactView';

const save = vi.fn();
const get = vi.fn();

function mountView(overrides: Partial<React.ComponentProps<typeof ActiveArtifactView>> = {}) {
  const ref = React.createRef<ActiveArtifactHandle>();
  const props = {
    artifact: { id: 'a1', kind: 'internal', path: 'notes.md' } as any,
    content: 'hello',
    projectRoot: '/proj',
    projectId: 'p1',
    projectName: 'Proj',
    sessionId: 's1',
    onContentChange: vi.fn(),
    ...overrides,
  };
  const utils = render(<ActiveArtifactView ref={ref} {...(props as any)} />);
  return { ref, utils, props };
}

beforeEach(() => {
  save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 100 });
  get.mockReset().mockResolvedValue({ ok: true, content: 'hello', orphan: false, mtimeMs: 42 });
  (window as any).claude = {
    artifacts: { save, get, onChanged: () => () => {} },
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ActiveArtifactView save safety', () => {
  it('NEVER saves while content is null (the §2.2 truncation guard)', async () => {
    const { ref } = mountView({ content: null });
    let ok: boolean | undefined;
    await act(async () => { ok = await ref.current!.saveEdit(); });
    expect(ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('is not editable while content is null, and not dirty either', () => {
    const { ref } = mountView({ content: null });
    expect(ref.current!.isEditable).toBe(false);
    expect(ref.current!.dirty).toBe(false);
  });

  it('denied-tier paths (D5 mirror) are not editable', () => {
    const { ref } = mountView({
      artifact: { id: 'a2', kind: 'internal', path: '.git/config' } as any,
      content: '[core]',
    });
    expect(ref.current!.isEditable).toBe(false);
  });

  it('binary / too-large content is not editable', () => {
    const bin = mountView({ content: null, contentInfo: { binary: true } });
    expect(bin.ref.current!.isEditable).toBe(false);
    const big = mountView({ content: null, contentInfo: { sizeBytes: 5e6 } });
    expect(big.ref.current!.isEditable).toBe(false);
  });

  // Found in Workbench review 2026-08-25: a file served as a PREFIX still
  // offered Edit, directly under a banner saying "Read-only". Saving would have
  // written the 2 MB prefix over the whole 8.4 MB file.
  it('a file served as a prefix offers no Edit and refuses to save', async () => {
    const { ref } = mountView({
      artifact: { id: 'a9', kind: 'internal', path: 'logs/server.log' } as any,
      content: 'first chunk\n',
      contentInfo: { binary: false, truncated: true, sizeBytes: 8.4 * 1024 * 1024 },
    });
    expect(ref.current!.isEditable).toBe(false);
    // Even reaching save directly through the host ref must not write.
    expect(await ref.current!.saveEdit()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  // The other half: a file that is over the cap but NOT truncated (the user
  // clicked "Load the whole file") stays read-only too — the cap exists because
  // the editor blocks the renderer on a multi-MB string.
  it('a fully loaded over-cap file is still not editable', () => {
    const { ref } = mountView({
      artifact: { id: 'a9', kind: 'internal', path: 'logs/server.log' } as any,
      content: 'the whole thing',
      contentInfo: { binary: false, truncated: false, sizeBytes: 8.4 * 1024 * 1024 },
    });
    expect(ref.current!.isEditable).toBe(false);
  });

  it('any text file is editable now (D4) — a .ts file, not just md/txt', () => {
    const { ref } = mountView({
      artifact: { id: 'a3', kind: 'internal', path: 'src/app.ts' } as any,
      content: 'export {};',
    });
    expect(ref.current!.isEditable).toBe(true);
  });

  it('round-trips the mtime token captured at startEdit into the save', async () => {
    const { ref } = mountView();
    await act(async () => { ref.current!.startEdit(); });
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => { await ref.current!.saveEdit(); });
    expect(save).toHaveBeenCalledTimes(1);
    const opts = save.mock.calls[0][6];
    expect(opts).toMatchObject({ baseMtimeMs: 42 });
  });

  it('stashes a dirty draft on unmount and restores it on remount (unguarded-discard safety net)', async () => {
    // Any layout change that unmounts the drawer (games panel, terminal
    // toggle, Project View, pill click) must degrade to draft-survives — the
    // review found three such paths in one pass, so the net, not the
    // enumeration, is what gets pinned.
    const first = mountView();
    await act(async () => { first.ref.current!.startEdit(); });
    await waitFor(() => expect(get).toHaveBeenCalled());
    const textarea = first.utils.container.querySelector('textarea')!;
    await act(async () => {
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.change(textarea, { target: { value: 'edited but not saved' } });
    });
    expect(first.ref.current!.dirty).toBe(true);
    first.utils.unmount(); // NO guard ran — simulates the games-panel case

    const second = mountView();
    await waitFor(() => expect(second.ref.current!.editing).toBe(true));
    expect(second.utils.container.querySelector('textarea')!.value).toBe('edited but not saved');
    // The restored draft still carries the concurrency token from startEdit.
    await act(async () => { await second.ref.current!.saveEdit(); });
    expect(save.mock.calls[0][6]).toMatchObject({ baseMtimeMs: 42 });
  });

  it('does NOT restore a draft that was saved before unmount', async () => {
    const first = mountView();
    await act(async () => { first.ref.current!.startEdit(); });
    await waitFor(() => expect(get).toHaveBeenCalled());
    const textarea = first.utils.container.querySelector('textarea')!;
    await act(async () => {
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.change(textarea, { target: { value: 'about to be saved' } });
    });
    await act(async () => { await first.ref.current!.saveEdit(); });
    first.utils.unmount();
    const second = mountView();
    await act(async () => {});
    expect(second.ref.current!.editing).toBe(false);
  });

  it('surfaces a conflict save as the conflict banner, not a silent overwrite', async () => {
    save.mockResolvedValue({ ok: false, error: 'conflict' });
    get.mockResolvedValue({ ok: true, content: 'disk version', orphan: false, mtimeMs: 99 });
    const { ref, utils } = mountView();
    await act(async () => { ref.current!.startEdit(); });
    let ok: boolean | undefined;
    await act(async () => { ok = await ref.current!.saveEdit(); });
    expect(ok).toBe(false);
    expect(utils.getByText(/changed on disk while you were editing/i)).toBeTruthy();
  });
});
