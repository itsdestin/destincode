// @vitest-environment jsdom
// CommentList — the Worker caps the thread at the 50 most recent and (since
// 2026-09-01) sends `total` beside it. These pin that the cut is SAID when it
// happens, and that nothing is said when it does not — including against an
// older Worker that sends no `total` at all (the two deploy independently).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

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

  it('tolerates an older Worker that sends no total', async () => {
    listComments.mockResolvedValue({ comments: fifty });
    render(<CommentList pluginId="p1" />);
    await waitFor(() => expect(screen.getByText('comment 49')).toBeTruthy());
    expect(screen.queryByText(/most recent of/i)).toBeNull();
  });
});
