// src/renderer/dev/workbench/compare/types.ts
//
// Shapes for the workbench's side-by-side comparison view. See registry.tsx for
// how a surface is authored and CompareView.tsx for how it is rendered.

import type React from 'react';

/** One candidate design. Three per round by convention — enough to see a real
 *  spread, few enough to hold in your head at once. */
export interface Candidate {
  /** Stable within its round. Recorded in the pick history, so renaming one
   *  orphans that round's recorded pick — pick a name and keep it. */
  id: string;
  /** Short name shown in the pane header. */
  label: string;
  /** One line on what is actually different about this one. The comparison is
   *  only useful if you can say why you preferred something. */
  note?: string;
  render: () => React.ReactNode;
}

export interface Round {
  /** 1-based. Must match the array position + 1 — the view trusts the array. */
  n: number;
  /** What this round was generated FROM, in words: "R1 · B (card-lift), with a
   *  lighter border". Empty on round 1. This is the lineage, and it is the
   *  reason iteration tracking exists — without it round 4 is three rounds of
   *  forgotten reasoning. */
  basis?: string;
  candidates: Candidate[];
}

/** How a candidate is mounted. Many app elements only look right in context —
 *  a card needs canvas behind it, a dialog's contents need a panel around it. */
export type CompareFrame =
  /** Bare, on the canvas background. Cards, rows, standalone controls. */
  | 'canvas'
  /** Inside a `.layer-surface` panel at dialog width. Use for the CONTENTS of a
   *  dialog or overlay — never render the real Dialog, which is fixed-position
   *  and would stack all three on top of each other in the middle of the
   *  screen. */
  | 'panel'
  /** Inside a `bg-inset` card, which is what a row nested in a panel sits on. */
  | 'inset';

export interface CompareSurface {
  /** Stable id; also the localStorage key for this surface's pick history. */
  id: string;
  label: string;
  /** One line: what question is this comparison answering? */
  question: string;
  frame: CompareFrame;
  /** Fixed pane width in px. Some surfaces only read correctly at their real
   *  width (a 448px dialog, a 288px popover); the panes never stretch past it. */
  paneWidth?: number;
  rounds: Round[];
}
