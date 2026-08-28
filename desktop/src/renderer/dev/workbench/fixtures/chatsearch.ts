// Fake chatsearch index for designing the session-reference cards. One entry
// per STATE the UI must show, keyed by uuid so the real parser accepts the
// short ids in the tool fixtures (fixtures/tools/chatsearch-*.jsonl) and the
// scenario conversation (fixtures/conversations/claude-code.jsonl). Special id
// CS_ERR_READ makes chatsearch.read fail with a real-looking error.
//
// WHY a separate table instead of reusing the seeded past sessions
// (scenarios.ts:76): those carry ids like `wb-past-0`, which the real
// hex-only parser (FIND_ROW_RE in shared/chatsearch-refs.ts) rejects outright,
// and none of them carry missingProject / notSyncedYet / tombstone. Every
// card state on the Task 7 checklist needs to be reachable, so this table
// exists purely to make that true.
import type { ResolvedConversation } from '../../../../shared/chatsearch-refs';

type Ok = Extract<ResolvedConversation, { status: 'ok' }>;
const base = (over: Partial<Ok>): Ok => ({
  status: 'ok', id: '', provider: 'claude', title: '', projectName: 'youcoded', originalPath: '/home/destin/youcoded-dev/youcoded',
  lastActive: '2026-07-26T03:14:09.000Z', createdAt: '2026-07-25T18:02:11.000Z', tags: [], complete: false, tombstone: false,
  projectSlug: '-home-destin-youcoded-dev-youcoded', projectPath: '/home/destin/youcoded-dev/youcoded', missingProject: false, notSyncedYet: false, ...over,
});

export const CS_RESUMABLE = 'a3f2aaaa-1111-4111-8111-111111111111';
export const CS_MISSING_PROJECT = '9c14bbbb-2222-4222-8222-222222222222';
export const CS_NOT_SYNCED = '1b07cccc-3333-4333-8333-333333333333';
export const CS_TOMBSTONE = '5e11dddd-4444-4444-8444-444444444444';
export const CS_NATIVE = '7a21eeee-5555-4555-8555-555555555555';
export const CS_UNTITLED = 'c0deffff-6666-4666-8666-666666666666';
export const CS_ERR_READ = 'ee0011aa-7777-4777-8777-777777777777';

export const CHATSEARCH_FIXTURE: Ok[] = [
  base({ id: CS_RESUMABLE, title: 'Permission ask timeout', tags: ['Follow-Up Needed', 'UI'], complete: true }),
  base({ id: CS_MISSING_PROJECT, title: 'Native runtime parity program', projectName: 'youcoded-dev', originalPath: '/Users/destin/youcoded-dev', lastActive: '2026-07-22T10:00:00.000Z', tags: ['Native Runtime'], missingProject: true, projectSlug: '', projectPath: '' }),
  base({ id: CS_NOT_SYNCED, title: 'Remote hydration hardening', lastActive: '2026-07-19T10:00:00.000Z', notSyncedYet: true }),
  base({ id: CS_TOMBSTONE, title: 'Old theme experiment', lastActive: '2026-05-02T10:00:00.000Z', tombstone: true }),
  base({ id: CS_NATIVE, title: 'Draft the newsletter', provider: 'native', projectName: 'writing', lastActive: '2026-08-01T10:00:00.000Z' }),
  base({ id: CS_UNTITLED, title: '', lastActive: '2026-08-10T10:00:00.000Z' }),
  base({ id: CS_ERR_READ, title: 'Conversation whose file is unreadable', lastActive: '2026-08-12T10:00:00.000Z' }),
];

export function resolveFixture(q: string): ResolvedConversation {
  const hits = CHATSEARCH_FIXTURE.filter((c) => c.id.startsWith(q));
  if (hits.length === 0) return { status: 'unknown', query: q };
  if (hits.length > 1) return { status: 'ambiguous', query: q, candidates: hits.map((h) => h.id) };
  return hits[0];
}
