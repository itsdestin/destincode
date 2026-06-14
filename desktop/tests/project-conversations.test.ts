import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/main/session-browser', () => ({
  listPastSessions: vi.fn(async () => ([
    { sessionId: 'a', name: 'A', projectSlug: '-home-u-proj', projectPath: '/home/u/proj', lastModified: 2, size: 999 },
    { sessionId: 'b', name: 'B', projectSlug: '-home-u-other', projectPath: '/home/u/other', lastModified: 1, size: 999 },
  ])),
  loadHistory: vi.fn(async () => ([{ role: 'user', content: 'hi', timestamp: 1 }])),
}));

import { listProjectConversations, projectConversationHistory } from '../src/main/project-conversations';

describe('listProjectConversations', () => {
  it('keeps only sessions whose slug matches the project path', async () => {
    const res = await listProjectConversations('/home/u/proj');
    expect(res.map(s => s.sessionId)).toEqual(['a']);
  });
});

describe('projectConversationHistory', () => {
  it('delegates to loadHistory with the derived slug', async () => {
    const msgs = await projectConversationHistory('/home/u/proj', 'a', 20, false);
    expect(msgs).toHaveLength(1);
  });
});
