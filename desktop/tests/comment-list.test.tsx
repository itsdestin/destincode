// @vitest-environment jsdom
// CommentList — the Worker caps the thread at the 50 most recent and (since
// 2026-09-01) sends `total` beside it. These pin that the cut is SAID when it
// happens, and that nothing is said when it does not — including against an
// older Worker that sends no `total` at all (the two deploy independently).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import type { CommentEntry } from '../src/renderer/state/marketplace-api-client';

const listComments = vi.fn();
vi.mock('../src/renderer/state/marketplace-api-client', () => ({
  MARKETPLACE_API_HOST: 'https://test.local',
  createMarketplaceApiClient: () => ({ listComments: (...a: unknown[]) => listComments(...a) }),
}));

import CommentList from '../src/renderer/components/marketplace/CommentList';

const row = (i: number) => ({
  id: `c${i}`, user_id: 'u1', user_login: 'alice', user_avatar_url: '', text: `comment ${i}`, created_at: 1_700_000_000 + i,
});
const fifty = Array.from({ length: 50 }, (_, i) => row(i));

beforeEach(() => { listComments.mockReset(); });
afterEach(cleanup);

describe('CommentList', () => {
  it('says the thread was cut when the Worker counts more than it listed', async () => {
    listComments.mockResolvedValue({ comments: fifty, total: 73 });
    render(<CommentList pluginId="p1" />);
    await waitFor(() => expect(screen.getByText('comment 49')).toBeTruthy());
    expect(screen.getByText(/showing the 50 most recent of 73 comments/i)).toBeTruthy();
  });

  it('says nothing when every comment is on the page', async () => {
    listComments.mockResolvedValue({ comments: fifty.slice(0, 3), total: 3 });
    render(<CommentList pluginId="p1" />);
    await waitFor(() => expect(screen.getByText('comment 2')).toBeTruthy());
    expect(screen.queryByText(/most recent of/i)).toBeNull();
  });

  it("shows the author's held comment, marked as held, even when the public thread is empty", async () => {
    listComments.mockResolvedValue({ comments: [], total: 0 });
    const held: CommentEntry[] = [{ id: 'h1', user_id: 'me', user_login: 'me', user_avatar_url: '', text: 'spicy take', created_at: 1_700_000_000 }];
    render(<CommentList pluginId="p1" held={held} />);
    await waitFor(() => expect(screen.getByText('spicy take')).toBeTruthy());
    expect(screen.getByText(/held for review/i)).toBeTruthy();
    // "No comments yet" above your own comment would be a lie.
    expect(screen.queryByText(/no comments yet/i)).toBeNull();
  });

  it('shows a held comment once and tells the caller when the public list now carries it', async () => {
    listComments.mockResolvedValue({ comments: [row(0), { ...row(1), id: 'h1', text: 'now public' }], total: 2 });
    const held: CommentEntry[] = [{ id: 'h1', user_id: 'me', user_login: 'me', user_avatar_url: '', text: 'now public', created_at: 1 }];
    const onHeldListed = vi.fn();
    render(<CommentList pluginId="p1" held={held} onHeldListed={onHeldListed} />);
    await waitFor(() => expect(screen.getByText('comment 0')).toBeTruthy());
    expect(screen.getAllByText('now public')).toHaveLength(1);
    expect(screen.queryByText(/held for review/i)).toBeNull();
    expect(onHeldListed).toHaveBeenCalledWith(['h1']);
  });

  it('tolerates an older Worker that sends no total', async () => {
    listComments.mockResolvedValue({ comments: fifty });
    render(<CommentList pluginId="p1" />);
    await waitFor(() => expect(screen.getByText('comment 49')).toBeTruthy());
    expect(screen.queryByText(/most recent of/i)).toBeNull();
  });
});
