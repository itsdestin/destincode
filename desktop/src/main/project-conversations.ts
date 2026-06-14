import { listPastSessions, loadHistory } from './session-browser';
import { cwdToProjectSlug } from './transcript-watcher';
import type { PastSession, HistoryMessage } from '../shared/types';

// CC encodes its project dirs with an UPPERCASE drive letter (C--Users-…), but
// YouCoded's canonical project paths can carry a LOWERCASE drive (c:/Users/…)
// from the artifact index canonicalizer. Uppercase the drive before slugifying
// so the slug matches CC's directory name. Windows paths are case-insensitive,
// so this only normalizes the drive letter; the rest of the path is untouched.
// Without this, project-filtered conversations come back EMPTY on Windows.
function ccProjectSlug(projectPath: string): string {
  const driveNormalized = projectPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  return cwdToProjectSlug(driveNormalized);
}

// Enriched session for the Conversations tab: adds a one-line preview (the first
// user message) and a message count so each row matches the prototype's convRow.
export interface ConversationSummary extends PastSession {
  preview: string;
  messageCount: number;
}

// WHY: listPastSessions is global. Project View needs just this project's
// sessions, so filter by the same slug CC uses for the project directory, then
// enrich each with a preview + message count (one transcript read apiece — this
// is a browse view, not a hot path).
export async function listProjectConversations(projectPath: string): Promise<ConversationSummary[]> {
  const slug = ccProjectSlug(projectPath);
  const all = await listPastSessions();
  const mine = all.filter((s) => s.projectSlug === slug);
  return Promise.all(
    mine.map(async (s) => {
      // s.projectSlug is the REAL on-disk dir name (correct case) from the
      // directory scan — use it directly, not the normalized input slug.
      const msgs = await loadHistory(s.sessionId, s.projectSlug, 0, true);
      const firstUser = msgs.find((m) => m.role === 'user');
      const preview = (firstUser?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return { ...s, preview, messageCount: msgs.length };
    }),
  );
}

export async function projectConversationHistory(
  projectPath: string, sessionId: string, count: number, all: boolean,
): Promise<HistoryMessage[]> {
  const slug = ccProjectSlug(projectPath);
  return loadHistory(sessionId, slug, count, all);
}
