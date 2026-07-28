// Injecting path-triggered content into a turn.
//
// TWO invariants this pins, both of which the rest of the branch depends on:
//
// 1. It arrives as a MESSAGE. The system prompt is byte-stable by construction
//    (prompt-assembly.ts's header comment is a standing instruction), and a
//    mid-session edit discards the KV cache prefix every local model reuses —
//    turning a cheap turn into a full re-prefill of the whole conversation.
//
// 2. Once per trigger per SESSION. A rule re-sent after every Read of a matching
//    file would dominate the conversation and blow the window it was sized against.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { TriggerIndex, PathTrigger } from '../src/main/harness/injection/path-triggers';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

/** A fake index that fires for every path — the point is what the DRIVER does
 *  with a hit, which path-triggers.test.ts already covers on its own. */
function always(...triggers: PathTrigger[]): TriggerIndex {
  return { match: () => triggers };
}
const never: TriggerIndex = { match: () => [] };

function run(triggers: TriggerIndex, scripts: any[][], profileOver: Partial<typeof CLOUD_DEFAULT> = {}) {
  const seen: any[] = [];
  const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
  const model = scriptedModel(scripts, seen);
  const session = new HarnessSession(
    makeOpts({ tools: [read], decide: async () => ALLOW, triggers, profile: { ...CLOUD_DEFAULT, ...profileOver } }),
    async () => model as any,
  );
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return { session, seen, events };
}

const TWO_STEP = [
  stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'src/api/a.ts' }), finishChunk('tool-calls')),
  stream(...textChunks('b', 'done'), finishChunk('stop')),
];

describe('path-triggered injection', () => {
  it('a matched trigger reaches the model as a MESSAGE', async () => {
    const { session, seen } = run(always({ id: 'r1', source: '.claude/rules/api.md', body: 'Always validate input.' }), TWO_STEP);
    await session.send('go');
    expect(JSON.stringify(seen)).toContain('Always validate input');
  });

  it('the system prompt is NOT touched — byte-stability is the whole constraint', async () => {
    const { session } = run(always({ id: 'r1', source: 'r', body: 'RULE' }), TWO_STEP);
    const before = (session as any).systemText;
    await session.send('go');
    expect((session as any).systemText).toBe(before);
  });

  it('names its source so the model knows where the text came from', async () => {
    const { session, seen } = run(always({ id: 'r1', source: '.claude/rules/api.md', body: 'RULE' }), TWO_STEP);
    await session.send('go');
    expect(JSON.stringify(seen)).toContain('.claude/rules/api.md');
  });

  it('the same trigger is injected only ONCE per session', async () => {
    const threeStep = [
      stream(toolCallChunk('c1', 'Read', { file_path: 'src/api/a.ts' }), finishChunk('tool-calls')),
      stream(toolCallChunk('c2', 'Read', { file_path: 'src/api/b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ];
    const { session, seen } = run(always({ id: 'r1', source: 'r', body: 'RULE-TEXT-MARKER' }), threeStep);
    await session.send('go');
    // Count in the FINAL prompt, not across all of them: once appended to
    // history the message correctly appears in every later step's prompt, so
    // summing across steps measures step count, not injection count.
    const lastPrompt = JSON.stringify(seen[seen.length - 1]);
    expect(lastPrompt.split('RULE-TEXT-MARKER').length - 1).toBe(1);
  });

  it('stays injected-once across TURNS, not just steps', async () => {
    const perTurn = [
      stream(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
      stream(toolCallChunk('c2', 'Read', { file_path: 'b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('c', 'done'), finishChunk('stop')),
    ];
    const { session, seen } = run(always({ id: 'r1', source: 'r', body: 'RULE-TEXT-MARKER' }), perTurn);
    await session.send('one');
    await session.send('two');
    const lastPrompt = JSON.stringify(seen[seen.length - 1]);
    expect(lastPrompt.split('RULE-TEXT-MARKER').length - 1).toBe(1);
  });

  it('no trigger, no injection — an ordinary turn is untouched', async () => {
    const { session, seen } = run(never, TWO_STEP);
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('project-rule');
  });

  it('a session with NO trigger index behaves exactly as before', async () => {
    // Every existing caller passes none; this must not become required.
    const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
    const model = scriptedModel(TWO_STEP);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    await expect(session.send('go')).resolves.toBeUndefined();
  });

  it('long content is cut to the profile budget, and says so', async () => {
    const { session, seen } = run(
      always({ id: 'r1', source: 'r', body: 'x'.repeat(40_000) }),
      TWO_STEP,
      { injectionBudgetTokens: 200 },
    );
    await session.send('go');
    const body = JSON.stringify(seen);
    expect(body).toMatch(/truncated/i);
    expect(body).not.toContain('x'.repeat(20_000));
  });
});

// ---------------------------------------------------------------------------
// Non-path subjects. Found in the 2026-07-28 branch review: the driver's rule
// was "everything except Bash has a path subject", spelled inline. Skill's
// subject is a skill id, so the moment it was added it silently inherited
// file-tool treatment — canonicalized against cwd, run through the credential
// denylist, and matched against rule globs. Benign in practice today, wrong in
// principle, and exactly the kind of thing that stops being benign quietly.
// ---------------------------------------------------------------------------
// The positive case — a FILE tool DOES trigger rules — is covered by
// 'a matched trigger reaches the model as a MESSAGE' at the top of this file,
// which uses Read. That pairing is what keeps this exclusion narrow.
describe('non-path tool subjects are not treated as paths', () => {
  it('a Skill call does not trigger path-scoped rules', async () => {
    const seen: any[] = [];
    // A trigger index that fires for ANY input — if Skill's subject reached it,
    // the rule would be injected.
    const firesForAnything: TriggerIndex = { match: () => [{ id: 'r', source: 'r', body: 'RULE-MARKER' }] };
    const skill = fakeTool('Skill', {
      schema: (await import('zod')).z.object({ skill: (await import('zod')).z.string() }),
      permissionSubject: (a: any) => a.skill,
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Skill', { skill: 'theme-builder' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(
      makeOpts({ tools: [skill], decide: async () => ALLOW, triggers: firesForAnything, profile: CLOUD_DEFAULT }),
      async () => model as any,
    );
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('RULE-MARKER');
  });

  it('a Bash call does not either', async () => {
    const seen: any[] = [];
    const firesForAnything: TriggerIndex = { match: () => [{ id: 'r', source: 'r', body: 'RULE-MARKER' }] };
    const bash = fakeTool('Bash', {
      schema: (await import('zod')).z.object({ command: (await import('zod')).z.string() }),
      permissionSubject: (a: any) => a.command,
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Bash', { command: 'ls src/api' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(
      makeOpts({ tools: [bash], decide: async () => ALLOW, triggers: firesForAnything, profile: CLOUD_DEFAULT }),
      async () => model as any,
    );
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('RULE-MARKER');
  });
});
