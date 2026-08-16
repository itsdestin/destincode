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
  /** The Task card itself — the popup renders its Briefing/Activity/Report
   *  sections verbatim (AgentSections), so it must be the live object. */
  tool: ToolCallState;
  /** Asks waiting on the user, oldest first. */
  asks: AskSegment[];
  /** Total tool calls so far (a live step count the ledger only writes at the end). */
  toolCalls: number;
  group: 'needs-you' | 'working' | 'finished';
}

export interface SpecialistSummary {
  helpers: HelperView[];
  needsYou: number;
  working: number;
  finished: number;
}

const EMPTY: SpecialistSummary = { helpers: [], needsYou: 0, working: 0, finished: 0 };

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
      const group: HelperView['group'] = asks.length > 0 ? 'needs-you' : run.status === 'running' ? 'working' : 'finished';
      helpers.push({ run, parentToolCallId: id, tool, asks, toolCalls: tools.length, group });
      // The card object is replaced immutably on EVERY change (reducer
      // `toolCalls.set(id, {...})`), so a version counter keyed on identity
      // would be ideal; a string key has to approximate it. Segment count +
      // last segment's shape/length + statuses of the tail + report/response
      // length catches every change the popup can display.
      const segs = tool.subagentSegments ?? [];
      const last = segs[segs.length - 1];
      keyParts.push([
        run.childId, run.status, run.stale ? 's' : '', run.steps ?? '', run.model?.label ?? '', segs.length,
        last ? `${last.type}:${last.id}:${'content' in last ? last.content.length : (last as AskSegment).status}` : '',
        tools.slice(-4).map(t => `${t.toolUseId}:${t.status}${t.askHeld ? 'h' : ''}${t.response ? t.response.length : ''}`).join('+'),
        asks.map(a => a.requestId).join('+'),
        tool.status, tool.response?.length ?? '', tool.specialistReport ? tool.specialistReport.status + tool.specialistReport.text.length : '',
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
