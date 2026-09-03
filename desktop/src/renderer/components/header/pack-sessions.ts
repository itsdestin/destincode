// Pure packing function for session pills. Given measured pill widths and
// an available budget, decides which pills show expanded (name + dot),
// which collapse to dot-only, and which overflow into the dropdown.
//
// Priority: active pill always visible. Prefer expanded over collapsed;
// prefer visible over overflow. Budget is in CSS px.

export interface SessionMeasurement {
  id: string;
  expandedWidth: number;
  collapsedWidth: number;
}

export interface PackInput {
  sessions: readonly SessionMeasurement[];
  activeId: string | null;
  /** The room the strip's CONTENT box has for its children — the wrapper's
   *  width minus the strip's own padding (SessionStrip's stripBudget). Until
   *  2026-09-03 the wrapper's full width was passed, so a full row was packed
   *  12px too wide and the active pill (the one flex item allowed to shrink)
   *  absorbed it: its name rendered 25px narrower than the packer had
   *  reserved, and a drag — judged against the reserved widths — moved every
   *  dot 25px too far, which snapped back on release. */
  budget: number;
  gap: number;
  triggerWidth: number;
  /** Width of the "+N" overflow chip (with its margin), reserved only when
   *  something overflows — the same squeeze as above, from the other tail
   *  element the packer did not know about. Default 0 keeps the pure tests. */
  overflowChipWidth?: number;
}

export interface PackResult {
  expanded: Set<string>;
  collapsed: string[];
  overflow: string[];
  /** The room the visible pills were packed into, after the tail reserves.
   *  What an active pill that does not fit is squeezed to (CSS shrinks it) —
   *  the strip caps its settled width at this, so the drag geometry and the
   *  drawn pill agree. */
  pillBudget: number;
}

/** Horizontal gap between pills, in CSS px. Matches `gap-0.5` on the strip.
 *  Shared with drag-order.ts so the two cannot drift apart. */
export const PILL_GAP = 2;

function sumWithGaps(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
}

// Caller guarantees session ids are unique within `sessions`.
export function packSessions(input: PackInput): PackResult {
  const { budget, gap, triggerWidth, overflowChipWidth = 0 } = input;
  // Budget available to pills, after reserving the ▾ trigger + one gap to it.
  const pillBudget = Math.max(0, budget - triggerWidth - gap);
  const first = packInto(input, pillBudget);
  if (first.overflow.length === 0 || overflowChipWidth <= 0) return first;
  // Something overflows, so the "+N" chip will be drawn too: pack again with
  // its room taken out. Less room can only overflow more, never less, so the
  // chip stays and one pass is enough.
  return packInto(input, Math.max(0, pillBudget - overflowChipWidth - gap));
}

function packInto(input: PackInput, pillBudget: number): PackResult {
  const { sessions, activeId, gap } = input;
  if (sessions.length === 0) {
    return { expanded: new Set(), collapsed: [], overflow: [], pillBudget };
  }

  const active = sessions.find(s => s.id === activeId) ?? null;
  const others = sessions.filter(s => s.id !== activeId);

  // Always include the active pill. Try expanded first, fall back to collapsed
  // if even its expanded width does not fit.
  if (active === null) {
    // No active session — fall back to packing all as collapsed by priority order.
    return greedyCollapsed(sessions, pillBudget, gap);
  }

  // Rule: the active pill is ALWAYS expanded (never collapsed to a dot).
  // If there's not enough room, overflow non-active pills first. If even the
  // active pill's expanded width exceeds the budget, we still render it
  // expanded and let CSS ellipsis truncate — the active session's name is
  // more useful than a handful of dots for its siblings.
  if (active.expandedWidth > pillBudget) {
    return {
      expanded: new Set([active.id]),
      collapsed: [],
      overflow: others.map(o => o.id),
      pillBudget,
    };
  }

  // Pack others as collapsed dots in original order, after reserving the
  // active pill's full expanded width.
  const collapsedIds: string[] = [];
  const overflowIds: string[] = [];
  let used = active.expandedWidth;
  for (const s of others) {
    const candidate = used + gap + s.collapsedWidth;
    if (candidate <= pillBudget) {
      collapsedIds.push(s.id);
      used = candidate;
    } else {
      overflowIds.push(s.id);
    }
  }

  // Upgrade: if every session is visible AND expanding all of them fits,
  // show all names (budget-driven allExpanded mode).
  if (overflowIds.length === 0) {
    const allExpandedWidth = sumWithGaps(
      [active.expandedWidth, ...others.map(o => o.expandedWidth)],
      gap,
    );
    if (allExpandedWidth <= pillBudget) {
      return {
        expanded: new Set(sessions.map(s => s.id)),
        collapsed: [],
        overflow: [],
        pillBudget,
      };
    }
  }

  return {
    expanded: new Set([active.id]),
    collapsed: collapsedIds,
    overflow: overflowIds,
    pillBudget,
  };
}

// Fallback when there is no active session — pack collapsed dots greedily.
function greedyCollapsed(
  sessions: readonly SessionMeasurement[],
  budget: number,
  gap: number,
): PackResult {
  const collapsed: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const s of sessions) {
    const candidate = collapsed.length === 0
      ? s.collapsedWidth
      : used + gap + s.collapsedWidth;
    if (candidate <= budget) {
      collapsed.push(s.id);
      used = candidate;
    } else {
      overflow.push(s.id);
    }
  }
  return { expanded: new Set(), collapsed, overflow, pillBudget: budget };
}
