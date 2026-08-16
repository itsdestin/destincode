import { useCallback, useRef, useEffect, useState, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { SpecialistRunView, ToolCallState, SpecialistDefinitionView, DelegatedModelsView } from '../../shared/types';

// Specialists 1c — narrow selectors over the chat store. A Task card carries
// ITS OWN run record on the tool prop (ToolCallState.specialistRun), so these
// exist only for the two reads that cross cards: a `task_id` management call
// naming another card's child, and the status-bar chip counting every child.
// Both return stable references (or primitives) so a subscriber re-renders
// only when the answer changes — never on every session update, which a plain
// useChatState() in a memoized ToolCard would do to the whole timeline.

/** The Task card whose child is `childId` (by run record, else stamped agentId). */
export function findSpecialistCardByChild(
  toolCalls: Map<string, ToolCallState>,
  childId: string,
): ToolCallState | undefined {
  for (const tool of toolCalls.values()) {
    if (tool.specialistRun?.childId === childId || tool.agentId === childId) return tool;
  }
  return undefined;
}

export function useSpecialistRunByChild(sessionId: string | undefined, childId: string | undefined): SpecialistRunView | undefined {
  const store = useChatStore();
  const subscribe = useCallback(
    (cb: () => void) => (sessionId ? store.subscribeSession(sessionId, cb) : () => {}),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => {
    if (!sessionId || !childId) return undefined;
    return findSpecialistCardByChild(store.getSession(sessionId).toolCalls, childId)?.specialistRun;
  }, [store, sessionId, childId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export interface SpecialistSummary {
  /** Children still working (their ledger status is 'running'). */
  running: SpecialistRunView[];
  /** Nested asks waiting on the user, oldest first: which child, what tool, and the request id. */
  waiting: Array<{ run: SpecialistRunView | undefined; parentToolCallId: string; toolName: string; requestId: string; held: boolean }>;
  /** Finished in the background since the user last looked (report folded into the card). */
  finished: SpecialistRunView[];
}

const EMPTY: SpecialistSummary = { running: [], waiting: [], finished: [] };

/** Everything the status-bar chip needs for one session. Recomputed on every
 *  session change but returned by reference only when the KEY changes, so the
 *  chip does not re-render on each streamed token. */
export function useSpecialistSummary(sessionId: string | undefined): SpecialistSummary {
  const store = useChatStore();
  const cache = useRef<{ key: string; value: SpecialistSummary }>({ key: '', value: EMPTY });
  const subscribe = useCallback(
    (cb: () => void) => (sessionId ? store.subscribeSession(sessionId, cb) : () => {}),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => {
    if (!sessionId) return EMPTY;
    const session = store.getSession(sessionId);
    const running: SpecialistRunView[] = [];
    const waiting: SpecialistSummary['waiting'] = [];
    const finished: SpecialistRunView[] = [];
    for (const [id, tool] of session.toolCalls) {
      const run = tool.specialistRun;
      if (run?.status === 'running') running.push(run);
      // A background hire that settled: card status went complete at launch,
      // so "finished" is the run record ending with the report folded in.
      if (run && run.background && (run.status === 'completed' || run.status === 'failed') && tool.specialistReport) finished.push(run);
      for (const seg of tool.subagentSegments ?? []) {
        if (seg.type === 'tool' && seg.status === 'awaiting-approval' && seg.requestId) {
          waiting.push({ run, parentToolCallId: id, toolName: seg.toolName, requestId: seg.requestId, held: !!seg.askHeld });
        }
      }
    }
    const key = [
      running.map(r => `${r.childId}:${r.stale ? 's' : ''}`).join(','),
      waiting.map(w => `${w.requestId}:${w.held ? 'h' : ''}`).join(','),
      finished.map(r => r.childId).join(','),
    ].join('|');
    if (key === cache.current.key) return cache.current.value;
    const value = running.length || waiting.length || finished.length ? { running, waiting, finished } : EMPTY;
    cache.current = { key, value };
    return value;
  }, [store, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------------------
// Roster + tiers — read once per page, shared by every card and the Settings
// screen. Both are `specialists.*` channels (MOCK_ONLY until the 1c backend
// lands); a missing bridge member resolves to null so a card in an older
// build simply omits the consent detail instead of crashing.
// ---------------------------------------------------------------------------

let rosterCache: SpecialistDefinitionView[] | null = null;
let rosterPromise: Promise<SpecialistDefinitionView[] | null> | null = null;
const rosterSubs = new Set<() => void>();

async function loadRoster(): Promise<SpecialistDefinitionView[] | null> {
  try {
    const list = await (window as any).claude?.specialists?.list?.();
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

/** Force a re-read (Settings calls this after the folder changed). */
export async function refreshSpecialistRoster(): Promise<void> {
  rosterPromise = loadRoster();
  rosterCache = await rosterPromise;
  for (const cb of rosterSubs) cb();
}

export function useSpecialistRoster(): SpecialistDefinitionView[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force(n => n + 1);
    rosterSubs.add(cb);
    if (!rosterPromise) {
      rosterPromise = loadRoster();
      rosterPromise.then(list => { rosterCache = list; for (const s of rosterSubs) s(); });
    }
    return () => { rosterSubs.delete(cb); };
  }, []);
  return rosterCache;
}

export function useDelegatedModels(): [DelegatedModelsView | null, (next: DelegatedModelsView) => void] {
  const [tiers, setTiers] = useState<DelegatedModelsView | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const t = await (window as any).claude?.specialists?.getDelegatedModels?.();
        if (live && t && typeof t === 'object') setTiers(t as DelegatedModelsView);
      } catch { /* leave null — the UI says "not set" */ }
    })();
    return () => { live = false; };
  }, []);
  return [tiers, setTiers];
}
