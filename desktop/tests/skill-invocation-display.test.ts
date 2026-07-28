// How a user-invoked skill APPEARS.
//
// Destin, 2026-07-28, on the first working /theme-builder: "this ui is terrible.
// it shouldn't just show the full text of the skill file as a user message."
// theme-builder's SKILL.md is ~26,000 characters, and /skill-name was routed
// through send(), so the whole file rendered as one chat bubble.
//
// The split this pins: the model's HISTORY gets the instructions, the TIMELINE
// gets a compact card. Both halves have to hold, including across a resume.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import { rebuildHistory } from '../src/main/harness/history-rebuild';
import { textChunks, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts } from './helpers/harness-fakes';

const BODY = '<skill-instructions name="p:theme-builder">\nBuild a theme.\n</skill-instructions>';

async function invoke(args?: string) {
  const seen: any[] = [];
  const model = scriptedModel([stream(...textChunks('a', 'ok'), finishChunk('stop'))], seen);
  const session = new HarnessSession(makeOpts({}), async () => model as any);
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  await session.runSkill({ skillId: 'p:theme-builder', displayName: 'Theme Builder', body: BODY, args, skillPath: '/x/SKILL.md' });
  return { events, seen };
}

describe('user-invoked skill — transcript', () => {
  it('emits skill-invoked, NOT user-message', async () => {
    const { events } = await invoke();
    expect(events.map((e) => e.type)).toContain('skill-invoked');
    expect(events.map((e) => e.type)).not.toContain('user-message');
  });

  it('carries what the CARD needs: id, display name, and the file to open', async () => {
    const { events } = await invoke();
    const e = events.find((x) => x.type === 'skill-invoked')!;
    expect(e.data.skillId).toBe('p:theme-builder');
    expect(e.data.displayName).toBe('Theme Builder');
    expect(e.data.skillPath).toBe('/x/SKILL.md');
  });

  it('still gives the MODEL the full instructions', async () => {
    const { seen } = await invoke();
    expect(JSON.stringify(seen)).toContain('Build a theme.');
  });

  it('puts the user\'s own words AFTER the instructions', async () => {
    // So a skill that says "act on what the user asked" has something to act on.
    const { seen } = await invoke('make it purple');
    const prompt = JSON.stringify(seen[0]);
    expect(prompt.indexOf('Build a theme.')).toBeLessThan(prompt.indexOf('make it purple'));
  });
});

describe('user-invoked skill — resume', () => {
  it('rebuildHistory restores the instructions, not just the card', async () => {
    // A resumed session must not replay a turn whose opening move has no cause.
    const { events } = await invoke();
    const e = events.find((x) => x.type === 'skill-invoked')!;
    const history = rebuildHistory([e]);
    expect(JSON.stringify(history)).toContain('Build a theme.');
    expect(history[0].role).toBe('user');
  });

  it('a skill-invoked event with no body contributes nothing rather than an empty turn', async () => {
    const bare = { type: 'skill-invoked', sessionId: 's', uuid: 'u', timestamp: 1, data: { skillId: 'x' } } as TranscriptEvent;
    expect(rebuildHistory([bare])).toEqual([]);
  });
});
