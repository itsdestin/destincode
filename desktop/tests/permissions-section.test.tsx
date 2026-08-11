// @vitest-environment jsdom
// permissions-section.test.tsx
// Render tests for Settings → Permissions (PermissionsSection.tsx), the screen
// that lists every "Always allow" a native session remembered and lets the user
// take it back. Plan: docs/active/plans/2026-08-11-native-permissions-management-ui-plan.md
//
// The screen was REDESIGNED after review: the default view is an overview
// (summary line → collapsible folder → kind group → row), not a flat log of
// every approval ever granted. These tests pin the behaviour that had to
// survive that change, plus the new structure itself.
//
// The jsdom docblock on line 1 is mandatory — vitest.config.ts runs the suite in
// the `node` environment and the per-glob override for .tsx was removed in
// Vitest 4, so without it this file dies on `document is not defined`.
//
// Cleanup is explicit for the same reason: `globals` is off, so
// @testing-library/react never finds a global afterEach to auto-register its
// unmount hook, and every render would otherwise stack in one document — which
// turns the single-match getByRole queries below into ambiguous-match failures.

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

/** N distinct Bash grants — enough to trip the "Show all" cut. */
function commands(n: number) {
  return Array.from({ length: n }, (_, i) => ({ tool: 'Bash', pattern: `cmd-${i}`, action: 'allow' }));
}

describe('PermissionsSection — the overview', () => {
  it('leads with a plain-language total before any folder is opened', async () => {
    list.mockResolvedValue([
      { slug: '-a', cwd: '/a', rules: commands(9) },
      { slug: '-b', cwd: '/b', rules: commands(3) },
      { slug: '-c', cwd: '/c', rules: commands(2) },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText('14 approvals across 3 folders.')).toBeTruthy();
  });

  it('gives each folder one collapsible header carrying its count', async () => {
    list.mockResolvedValue([
      { slug: '-a', cwd: '/home/d/alpha', rules: commands(9) },
      { slug: '-b', cwd: '/home/d/beta', rules: commands(9) },
      { slug: '-c', cwd: '/home/d/gamma', rules: commands(9) },
    ]);
    render(<PermissionsSection />);
    const header = await screen.findByRole('button', { name: /alpha/i });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('9');
    // Collapsed: none of the rows are in the document at all.
    expect(screen.queryByText('cmd-0')).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('cmd-0')).toBeTruthy();
  });

  it('opens a single small folder without a click, and starts a crowded screen collapsed', async () => {
    list.mockResolvedValue([{ slug: '-a', cwd: '/home/d/alpha', rules: commands(3) }]);
    render(<PermissionsSection />);
    expect(await screen.findByText('cmd-0')).toBeTruthy();
    cleanup();

    list.mockResolvedValue([
      { slug: '-a', cwd: '/a', rules: commands(3) },
      { slug: '-b', cwd: '/b', rules: commands(3) },
      { slug: '-c', cwd: '/c', rules: commands(3) },
    ]);
    render(<PermissionsSection />);
    // All three headers present, all three collapsed.
    expect(await screen.findAllByRole('button', { expanded: false })).toHaveLength(3);
    expect(screen.queryByText('cmd-0')).toBeNull();
  });

  it('groups an open folder by kind rather than listing everything in one run', async () => {
    list.mockResolvedValue([
      { slug: '-a', cwd: '/a', rules: [
        { tool: 'Bash', pattern: 'git status', action: 'allow' },
        { tool: 'Write', pattern: 'src/a.ts', action: 'allow' },
        { tool: 'WebFetch', pattern: 'example.com', action: 'allow' },
        { tool: 'Read', pattern: 'notes.md', action: 'allow' },
      ] },
    ]);
    render(<PermissionsSection />);
    // Headings are <h3>; the folder header is a <button>, so these queries
    // cannot accidentally match it.
    expect(await screen.findByRole('heading', { name: 'Commands' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'File changes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Other' })).toBeTruthy();
    // A kind with nothing in it is not rendered as an empty heading.
    cleanup();
    list.mockResolvedValue([{ slug: '-a', cwd: '/a', rules: commands(2) }]);
    render(<PermissionsSection />);
    expect(await screen.findByRole('heading', { name: 'Commands' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
  });

  it('truncates a long kind behind “Show all N”', async () => {
    list.mockResolvedValue([{ slug: '-a', cwd: '/a', rules: commands(8) }]);
    render(<PermissionsSection />);
    // 8 rules, 5 shown. Opened by default (one folder, ≤ 8 approvals).
    expect(await screen.findByText('cmd-4')).toBeTruthy();
    expect(screen.queryByText('cmd-5')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(screen.getByText('cmd-7')).toBeTruthy();
  });

  it('does not hide a single row behind a click', async () => {
    // 6 rules is one over the cut; hiding exactly one is worse than showing it.
    list.mockResolvedValue([{ slug: '-a', cwd: '/a', rules: commands(6) }]);
    render(<PermissionsSection />);
    expect(await screen.findByText('cmd-5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show all/i })).toBeNull();
  });
});

describe('PermissionsSection — behavioural contracts', () => {
  it('shows the folder name and its path', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-proj', cwd: '/home/d/proj', rules: [
        { tool: 'Bash', pattern: 'git push origin main', action: 'allow' },
      ] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByRole('button', { name: /proj/ })).toBeTruthy();
    expect(screen.getByText('/home/d/proj')).toBeTruthy();
    expect(screen.getByText('git push origin main')).toBeTruthy();
  });

  it('says so when the folder was never recorded, and never invents a path', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-notes', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText(/folder wasn't recorded/i)).toBeTruthy();
    // The slug is the heading — the only name we actually have.
    expect(screen.getByRole('button', { name: /-home-d-notes/ })).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: /^Remove approval:/ }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/asked the next time/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing approval:/ }));
    // The SLUG, not the cwd — a path cannot be reconstructed from a slug.
    await waitFor(() => expect(remove).toHaveBeenCalledWith('-home-d-proj', rule));
  });

  it('cancels the confirm on Escape', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] }]);
    render(<PermissionsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove approval:/ }));
    const commit = screen.getByRole('button', { name: /^Confirm removing approval:/ });
    fireEvent.keyDown(commit, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /^Confirm removing approval:/ })).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the row when the backend reports nothing matched', async () => {
    const rule = { tool: 'Bash', pattern: 'ls', action: 'allow' };
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [rule] }]);
    remove.mockResolvedValue(false);   // stale list — the rule was already gone
    render(<PermissionsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove approval:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing approval:/ }));
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
    // The row is still on screen — reporting success would teach the user to
    // trust a list that lied to them.
    expect(screen.getByText('ls')).toBeTruthy();
  });

  // Bulk removal is the one action here with no precedent in the settings
  // family, so it is gated exactly like a single row and lives in the folder
  // body rather than the heading.
  it('gates the per-folder Remove all behind the same confirm', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(3) }]);
    removeProject.mockResolvedValue(true);
    render(<PermissionsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove all 3 for this folder' }));
    expect(removeProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing all approvals/ }));
    await waitFor(() => expect(removeProject).toHaveBeenCalledWith('-p'));
  });

  it('offers no bulk action for a folder with a single approval', async () => {
    // "Remove all 1" is the row's own Remove button wearing a scarier label.
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(1) }]);
    render(<PermissionsSection />);
    expect(await screen.findByText('cmd-0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /remove all/i })).toBeNull();
  });

  it('keeps the folder when the bulk removal reports nothing matched', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(2) }]);
    removeProject.mockResolvedValue(false);
    render(<PermissionsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove all 2 for this folder' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing all approvals/ }));
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
    expect(screen.getByText('cmd-0')).toBeTruthy();
  });

  // The stress fixture's worktree shares its basename with its parent repo, so a
  // heading built from basename alone renders two identical headings over two
  // genuinely different rule sets — the user revokes from whichever they guessed.
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
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the general two-action error card when the list cannot be read', async () => {
    list.mockRejectedValue(new Error('nope'));
    render(<PermissionsSection />);
    // <ErrorState mode="general"> — never a hand-rolled card, never a guessed cause.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diagnose with Claude' })).toBeTruthy();
  });
});
