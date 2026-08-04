// Round-trip pin for the reference scaffold module (spec 2026-07-26 inline
// reply). build-reference.ts's own tests already pin the exact promptText
// strings for each shape (moved verbatim from v1) — this file's job is the
// OTHER direction: given a dispatched message's content, can the parser
// recover the pieces the builder put in?
import { describe, it, expect } from 'vitest';
import {
  LEAD_ASSISTANT,
  LEAD_USER,
  LEAD_NEUTRAL,
  LEAD_CODE,
  FOLLOW_UP_MARKER,
  buildScaffold,
  buildArtifactScaffold,
  parseReferencePrompt,
} from './reference-prompt';

// Mirrors InputBar's buildOutgoingMessage sanitize step (outgoing-message.ts):
// composeOutgoing() prepends promptText to the draft, and THAT combined
// string — not promptText alone — is what gets flattened before it ever
// becomes a dispatched message's content. Reproduced here (rather than
// imported) so this stays a pure test of reference-prompt.ts's own contract:
// it must survive whatever InputBar does to it, not just its own output.
function flatten(rawText: string): string {
  return rawText.replace(/[\r\n]+/g, ' ').trim();
}

describe('buildScaffold / parseReferencePrompt round-trip (chat-text)', () => {
  it('round-trips the assistant lead-in', () => {
    const promptText = buildScaffold(LEAD_ASSISTANT, 'the reducer preserves Map refs', false);
    const content = promptText + "what's in it?";
    const parsed = parseReferencePrompt(content);
    expect(parsed).toEqual({
      kind: 'chat-text',
      lead: LEAD_ASSISTANT,
      quote: 'the reducer preserves Map refs',
      fenced: false,
      followUp: "what's in it?",
    });
  });

  it('round-trips the user lead-in', () => {
    const promptText = buildScaffold(LEAD_USER, 'why does memo work', false);
    const parsed = parseReferencePrompt(promptText + 'good question actually');
    expect(parsed?.kind).toBe('chat-text');
    if (parsed?.kind === 'chat-text') {
      expect(parsed.lead).toBe(LEAD_USER);
      expect(parsed.quote).toBe('why does memo work');
      expect(parsed.followUp).toBe('good question actually');
    }
  });

  it('round-trips the neutral lead-in', () => {
    const promptText = buildScaffold(LEAD_NEUTRAL, 'floating text', false);
    const parsed = parseReferencePrompt(promptText + 'ok');
    expect(parsed?.kind).toBe('chat-text');
    if (parsed?.kind === 'chat-text') expect(parsed.lead).toBe(LEAD_NEUTRAL);
  });
});

describe('buildScaffold / parseReferencePrompt round-trip (chat-code)', () => {
  it('round-trips a fenced code reference', () => {
    const promptText = buildScaffold(LEAD_CODE, 'const x = 1;', true);
    const parsed = parseReferencePrompt(promptText + 'what does x do?');
    expect(parsed).toEqual({
      kind: 'chat-code',
      lead: LEAD_CODE,
      quote: 'const x = 1;',
      fenced: true,
      followUp: 'what does x do?',
    });
  });
});

describe('buildArtifactScaffold / parseReferencePrompt round-trip (artifact)', () => {
  it('round-trips a line-number descriptor', () => {
    const promptText = buildArtifactScaffold('line 2', 'docs/notes.txt');
    const parsed = parseReferencePrompt(promptText + 'what happens here?');
    expect(parsed).toEqual({
      kind: 'artifact',
      descriptor: 'line 2',
      path: 'docs/notes.txt',
      followUp: 'what happens here?',
    });
  });

  it('round-trips a quoted-excerpt descriptor (no line number found)', () => {
    const promptText = buildArtifactScaffold('"some excerpt"', 'src/foo.ts');
    const parsed = parseReferencePrompt(promptText + 'explain');
    expect(parsed).toEqual({
      kind: 'artifact',
      descriptor: '"some excerpt"',
      path: 'src/foo.ts',
      followUp: 'explain',
    });
  });
});

describe('parseReferencePrompt on a non-scaffold message', () => {
  it('returns null for an ordinary typed message', () => {
    expect(parseReferencePrompt('what is the plan for today?')).toBeNull();
  });

  it('returns null for a message that merely mentions the marker text', () => {
    expect(parseReferencePrompt(`I saw "${FOLLOW_UP_MARKER}" in the code somewhere`)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseReferencePrompt('')).toBeNull();
  });
});

// The integration case that actually matters: after InputBar's
// buildOutgoingMessage sanitize collapses every '\n'/'\n\n' run in the
// scaffold to a single space (see this module's header comment), the parser
// must still recognize the shape from what's ACTUALLY dispatched — not the
// idealized multi-line string buildScaffold() returns in isolation.
describe('parseReferencePrompt against InputBar-flattened content', () => {
  it('recovers a chat-text reference after newline flattening', () => {
    const promptText = buildScaffold(LEAD_ASSISTANT, 'Done! Created a test file at test-temp.txt.', false);
    const flattened = flatten(promptText + "what's in it?");
    expect(flattened).not.toContain('\n'); // sanity: flattening actually happened
    const parsed = parseReferencePrompt(flattened);
    expect(parsed).toEqual({
      kind: 'chat-text',
      lead: LEAD_ASSISTANT,
      quote: 'Done! Created a test file at test-temp.txt.',
      fenced: false,
      followUp: "what's in it?",
    });
  });

  it('recovers a chat-code reference after newline flattening (multi-line code collapses to one line)', () => {
    const promptText = buildScaffold(LEAD_CODE, 'const x = 1;\nconst y = 2;', true);
    const flattened = flatten(promptText + 'explain');
    const parsed = parseReferencePrompt(flattened);
    expect(parsed?.kind).toBe('chat-code');
    if (parsed?.kind === 'chat-code') {
      // The original two lines are now one — that information is genuinely
      // gone by the time this string reaches the parser (InputBar's sanitize
      // did that, not us). The parser's job is just to recover exactly what
      // survived, not to un-flatten it.
      expect(parsed.quote).toBe('const x = 1; const y = 2;');
      expect(parsed.followUp).toBe('explain');
    }
  });

  it('recovers an artifact reference after flattening, with an empty follow-up', () => {
    const promptText = buildArtifactScaffold('lines 12-14', 'chat-reducer.ts');
    const flattened = flatten(promptText); // no draft typed — the trim() edge case
    const parsed = parseReferencePrompt(flattened);
    expect(parsed).toEqual({
      kind: 'artifact',
      descriptor: 'lines 12-14',
      path: 'chat-reducer.ts',
      followUp: '',
    });
  });
});
