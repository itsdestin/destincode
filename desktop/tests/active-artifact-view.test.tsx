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
    const big = mountView({ content: null, contentInfo: { tooLarge: true, sizeBytes: 5e6 } });
    expect(big.ref.current!.isEditable).toBe(false);
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
