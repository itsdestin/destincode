import { listPastSessions, loadHistory } from './session-browser';
import { cwdToProjectSlug } from './transcript-watcher';
import type { PastSession, HistoryMessage } from '../shared/types';

// WHY: listPastSessions is global. Project View needs just this project's
// sessions, so filter by the same slug CC uses for the project directory.
export async function listProjectConversations(projectPath: string): Promise<PastSession[]> {
  const slug = cwdToProjectSlug(projectPath);
  const all = await listPastSessions();
  return all.filter((s) => s.projectSlug === slug);
}

export async function projectConversationHistory(
  projectPath: string, sessionId: string, count: number, all: boolean,
): Promise<HistoryMessage[]> {
  const slug = cwdToProjectSlug(projectPath);
  return loadHistory(sessionId, slug, count, all);
}
