/**
 * A subagent's transcript must never be enumerated as a conversation.
 *
 * Today this holds by ACCIDENT rather than by rule: both enumerators list
 * `*.jsonl` directly inside a project slug folder and never recurse, while a
 * subagent's transcript lives one level further down, in
 * `<slug>/<session-id>/subagents/agent-N.jsonl`. Nothing states the intent, so
 * a future change to recursive discovery — a reasonable-looking change — would
 * quietly start offering subagents as conversations you can Resume.
 *
 * This file promotes the accident to a rule. It is the enumerator half of the
 * same guarantee the preview reader enforces from the other side (it refuses a
 * subagent path AND all-sidechain content, in chatsearch-transcript-reader.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPastSessions } from '../src/main/session-browser';
import { reconcile } from '../src/main/conversations/reconciler';

const ID = 'a3f2aaaa-0000-4000-8000-000000000000';
const SLUG = '-home-destin-youcoded';
const FX = path.join(__dirname, 'fixtures', 'chatsearch');

/** A projects tree holding one real conversation and one subagent beneath it. */
function tmpProjects() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-subagent-'));
  const slugDir = path.join(dir, SLUG);
  fs.mkdirSync(path.join(slugDir, ID, 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(FX, 'claude-session.jsonl'), path.join(slugDir, `${ID}.jsonl`));
  fs.copyFileSync(path.join(FX, 'subagent.jsonl'), path.join(slugDir, ID, 'subagents', 'agent-1.jsonl'));
  return dir;
}

/** Positive control. Without this, both tests below would still pass on a tree
 *  that simply has no subagent in it — proving nothing at all. */
function decoyExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, SLUG, ID, 'subagents', 'agent-1.jsonl'));
}

describe('subagent transcripts are never enumerated as sessions', () => {
  it('listPastSessions returns the conversation and nothing from subagents/', async () => {
    const dir = tmpProjects();
    expect(decoyExists(dir)).toBe(true);
    const sessions = await listPastSessions(undefined, [], dir);
    expect(sessions.map((s) => s.sessionId)).toEqual([ID]);
    expect(sessions.some((s) => s.sessionId.startsWith('agent-'))).toBe(false);
  });

  it('the reconciler records the conversation and nothing from subagents/', async () => {
    const dir = tmpProjects();
    expect(decoyExists(dir)).toBe(true);
    const topics = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-topics-'));
    const recorded: string[] = [];
    // A minimal stand-in for ConversationStore: the scan only needs to be able
    // to look a record up and write one, and we only care WHICH ids it writes.
    const store = {
      list: async () => [],
      upsert: async (rec: { id: string }) => { recorded.push(rec.id); return rec; },
    } as unknown as Parameters<typeof reconcile>[0]['store'];
    await reconcile({ projectsDir: dir, topicsDir: topics, store, device: 'test', mirror: () => {} });
    expect(recorded).toEqual([ID]);
  });
});
