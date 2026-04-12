import React from 'react';

// Keywords that get the animated "flowing" gradient treatment in the chat
// input and in user bubbles. Longer alternatives come first so "ultraplan"
// wins over "plan" at the same position. \b ensures we only match whole
// words — "planner" and "subplan" are left alone.
export const FLOWING_KEYWORD_RE = /\b(ultrathink|ultraplan|brainstorm|plan)\b/gi;

export interface FlowingSegment {
  text: string;
  flowing: boolean;
}

export function splitFlowingKeywords(text: string): FlowingSegment[] {
  const parts: FlowingSegment[] = [];
  let last = 0;
  FLOWING_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLOWING_KEYWORD_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), flowing: false });
    parts.push({ text: m[0], flowing: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), flowing: false });
  return parts;
}

/** Plain-text renderer with keyword spans. No URL linking. */
export default function FlowingKeywordsText({ text }: { text: string }) {
  const parts = splitFlowingKeywords(text);
  return (
    <>
      {parts.map((p, i) =>
        p.flowing ? (
          <span key={i} className="flowing-word">{p.text}</span>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </>
  );
}
