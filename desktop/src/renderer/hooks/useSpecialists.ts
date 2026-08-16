import { useCallback, useRef, useEffect, useState, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { SpecialistRunView, ToolCallState, SpecialistDefinitionView, DelegatedModelsView, SubagentSegment } from '../../shared/types';

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

export type AskSegment = Extract<SubagentSegment, { type: 'tool' }>;

/** Everything the management popup shows for ONE helper — read off its Task card. */
export interface HelperView {
  run: SpecialistRunView;
  parentToolCallId: string;
  /** Asks waiting on the user, oldest first. */
  asks: AskSegment[];
  /** The last few tool segments, newest last — the "what is it doing" strip. */
  recent: AskSegment[];
  /** The tool it is on right now, if a tool call is open. */
  current?: AskSegment;
  /** Total tool calls so far (a live step count the ledger only writes at the end). */
  toolCalls: number;
  /** Folded background report (or the foreground report text). */
  report?: { text: string; status: 'completed' | 'failed' };
  group: 'needs-you' | 'working' | 'finished';
}

export interface SpecialistSummary {
  helpers: HelperView[];
  needsYou: number;
  working: number;
  finished: number;
}

const EMPTY: SpecialistSummary = { helpers: [], needsYou: 0, working: 0, finished: 0 };
const RECENT = 3;

/** Everything the status-bar chip + popup need for one session. Recomputed on
 *  every session change but returned by reference only when the KEY changes,
 *  so the chip does not re-render on each streamed token. */
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
    const helpers: HelperView[] = [];
    const keyParts: string[] = [];
    for (const [id, tool] of session.toolCalls) {
      const run = tool.specialistRun;
      if (!run) continue;
      const tools: AskSegment[] = [];
      for (const seg of tool.subagentSegments ?? []) if (seg.type === 'tool') tools.push(seg);
      const asks = tools.filter(t => t.status === 'awaiting-approval' && !!t.requestId);
      const current = [...tools].reverse().find(t => t.status === 'running');
      const report = tool.specialistReport
        ? { text: tool.specialistReport.text, status: tool.specialistReport.status }
        : (!run.background && tool.response && run.status !== 'running') ? { text: tool.response, status: 'completed' as const } : undefined;
      const group: HelperView['group'] = asks.length > 0 ? 'needs-you' : run.status === 'running' ? 'working' : 'finished';
      helpers.push({ run, parentToolCallId: id, asks, recent: tools.slice(-RECENT), current, toolCalls: tools.length, report, group });
      keyParts.push([
        run.childId, run.status, run.stale ? 's' : '', run.steps ?? '', tools.length,
        asks.map(a => `${a.requestId}${a.askHeld ? 'h' : ''}`).join('+'),
        current?.toolUseId ?? '', tools.slice(-RECENT).map(t => `${t.toolUseId}:${t.status}`).join('+'),
        report ? report.status + report.text.length : '',
      ].join(':'));
    }
    const key = keyParts.join('|');
    if (key === cache.current.key) return cache.current.value;
    const value: SpecialistSummary = helpers.length === 0 ? EMPTY : {
      helpers,
      needsYou: helpers.filter(h => h.group === 'needs-you').length,
      working: helpers.filter(h => h.group === 'working').length,
      finished: helpers.filter(h => h.group === 'finished').length,
    };
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
