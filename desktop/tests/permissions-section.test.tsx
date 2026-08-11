// @vitest-environment jsdom
// permissions-section.test.tsx
// Render tests for Settings → Permissions (PermissionsSection.tsx), the screen
// that lists every "Always allow" a native session remembered and lets the user
// take it back. Plan: docs/active/plans/2026-08-11-native-permissions-management-ui-plan.md
//
// The jsdom docblock on line 1 is mandatory — vitest.config.ts runs the suite in
// the `node` environment and the per-glob override for .tsx was removed in
// Vitest 4, so without it this file dies on `document is not defined`.
//
// Cleanup is explicit for the same reason: `globals` is off, so
// @testing-library/react never finds a global afterEach to auto-register its
// unmount hook, and every render would otherwise stack in one document — which
// turns the single-match getByRole('button', { name: /^remove$/i }) queries
// below into ambiguous-match failures.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import PermissionsSection from '../src/renderer/components/PermissionsSection';

const list = vi.fn();
const remove = vi.fn();
const removeProject = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as any).window.claude = { permissions: { list, remove, removeProject } };
});

afterEach(() => {
  cleanup();
});

describe('PermissionsSection', () => {
  it('groups rules by project and shows the folder name', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-proj', cwd: '/home/d/proj', rules: [
        { tool: 'Bash', pattern: 'git push origin main', action: 'allow' },
      ] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText('proj')).toBeTruthy();
    expect(screen.getByText('/home/d/proj')).toBeTruthy();
    expect(screen.getByText(/git push origin main/)).toBeTruthy();
  });

  it('says so when the folder was never recorded', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-notes', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText(/folder wasn't recorded/i)).toBeTruthy();
  });

  it('marks a pattern-less grant as covering every use of the tool', async () => {
    list.mockResolvedValue([
      { slug: '-p', cwd: '/p', rules: [{ tool: 'Write', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText(/every file/i)).toBeTruthy();
  });

  // The confirm is the guard against a mis-click revoking something the user
  // wanted. A single-click remove would be a regression, not a simplification.
  it('requires a confirm before removing, then calls remove with the SLUG', async () => {
    const rule = { tool: 'Bash', pattern: 'git push origin main', action: 'allow' };
    list.mockResolvedValue([{ slug: '-home-d-proj', cwd: '/home/d/proj', rules: [rule] }]);
    remove.mockResolvedValue(true);
    render(<PermissionsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/asked the next time/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('-home-d-proj', rule));
  });

  it('keeps the row when the backend reports nothing matched', async () => {
    const rule = { tool: 'Bash', pattern: 'ls', action: 'allow' };
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [rule] }]);
    remove.mockResolvedValue(false);   // stale list — the rule was already gone
    render(<PermissionsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
  });

  // The stress fixture's worktree shares its basename with its parent repo, so a
  // heading built from basename alone renders two identical headings over two
  // genuinely different rule sets — the user revokes from whichever they guessed.
  // Added beyond the plan's six because nothing else catches this silently.
  it('disambiguates two projects whose folders share a name', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-youcoded-dev-youcoded', cwd: '/home/d/youcoded-dev/youcoded',
        rules: [{ tool: 'Bash', pattern: 'a', action: 'allow' }] },
      { slug: '-home-d-youcoded-dev-worktrees-youcoded', cwd: '/home/d/youcoded-dev/worktrees/youcoded',
        rules: [{ tool: 'Bash', pattern: 'b', action: 'allow' }] },
      // A third project whose name is already unique must NOT be widened.
      { slug: '-home-d-notes', cwd: '/home/d/notes',
        rules: [{ tool: 'Bash', pattern: 'c', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText('youcoded-dev/youcoded')).toBeTruthy();
    expect(screen.getByText('worktrees/youcoded')).toBeTruthy();
    expect(screen.queryByText('youcoded')).toBeNull();
    expect(screen.getByText('notes')).toBeTruthy();
  });

  it('renders an empty state rather than an error when nothing is granted', async () => {
    list.mockResolvedValue([]);
    render(<PermissionsSection />);
    expect(await screen.findByText(/haven't approved anything/i)).toBeTruthy();
  });
});
