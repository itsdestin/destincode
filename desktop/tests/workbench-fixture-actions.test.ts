import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixture } from '../src/renderer/dev/workbench/fixture-loader';

const FIXTURE_ROOT = join(__dirname, '../src/renderer/dev/workbench/fixtures');

/** Every line kind loadFixture recognises. Anything else is SILENTLY SKIPPED by
 *  the loader, so a typo'd kind in a fixture would simply vanish from the
 *  timeline with no error — which is exactly the failure this guards. */
const KNOWN_KINDS = new Set([
  'text', 'user_message', 'assistant_text', 'tool_use', 'tool_result',
  'permission_request',
]);

function fixtureFiles(dir: string): Array<{ name: string; raw: string }> {
  return readdirSync(join(FIXTURE_ROOT, dir))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f.replace('.jsonl', ''),
      raw: readFileSync(join(FIXTURE_ROOT, dir, f), 'utf8'),
    }));
}

const CONVO = [
  '{"type":"user_message","text":"fix the scroll stick"}',
  '{"type":"assistant_text","text":"Reading ChatView.tsx."}',
  '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/ChatView.tsx"}}',
  '{"type":"tool_result","tool_use_id":"t1","content":"ok"}',
].join('\n');

describe('fixture replay', () => {
  it('emits an action per user_message and assistant_text line', () => {
    const r = loadFixture('convo', CONVO);
    expect(r.error).toBeUndefined();
    const types = r.actions.map((a) => a.type);
    expect(types).toContain('USER_PROMPT');
    expect(types).toContain('TRANSCRIPT_ASSISTANT_TEXT');
  });

  // Every action the loader dispatched must be returned, or replaying the list
  // into a live reducer produces a DIFFERENT timeline than the loader built —
  // which is the one thing this file exists to prevent.
  it('returns every action it dispatched, in order', () => {
    const r = loadFixture('convo', CONVO);
    expect(r.actions.map((a) => a.type)).toEqual([
      'USER_PROMPT',
      'TRANSCRIPT_ASSISTANT_TEXT',
      'TRANSCRIPT_TOOL_USE',
      'TRANSCRIPT_TOOL_RESULT',
    ]);
  });

  // The reducer requires these fields; a fixture that omits them would build a
  // timeline the live app could never produce.
  it('stamps the fields the real actions require', () => {
    const r = loadFixture('convo', CONVO);
    const prompt = r.actions.find((a) => a.type === 'USER_PROMPT') as any;
    // `content`, NOT `text` — chat-types.ts:319-326.
    expect(prompt.content).toBe('fix the scroll stick');
    expect(typeof prompt.timestamp).toBe('number');

    const text = r.actions.find((a) => a.type === 'TRANSCRIPT_ASSISTANT_TEXT') as any;
    expect(text.text).toBe('Reading ChatView.tsx.');
    expect(typeof text.timestamp).toBe('number');
    expect(typeof text.uuid).toBe('string');
  });

  it('still returns tool blocks for the existing tool fixtures', () => {
    const r = loadFixture('convo', CONVO);
    expect(r.blocks.filter((b) => b.kind === 'tool')).toHaveLength(1);
  });

  it('reports a parse error rather than throwing', () => {
    const bad = loadFixture('bad', '{not json}');
    expect(bad.error).toContain('parse error');
    expect(bad.actions).toEqual([]);
  });
});

// Spec §8: every shipped fixture must replay into a well-formed timeline.
describe('shipped fixtures replay', () => {
  const all = [...fixtureFiles('tools'), ...fixtureFiles('conversations')];

  it('finds the fixtures (a glob that matches nothing would pass vacuously)', () => {
    expect(fixtureFiles('tools').length).toBeGreaterThanOrEqual(24);
    expect(fixtureFiles('conversations').length).toBeGreaterThanOrEqual(2);
  });

  it.each(all)('$name parses with no error', ({ name, raw }) => {
    expect(loadFixture(name, raw).error).toBeUndefined();
  });

  it.each(all)('$name uses only line kinds the loader handles', ({ raw }) => {
    const unknown = raw.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => JSON.parse(l).type)
      .filter((t) => !KNOWN_KINDS.has(t));
    expect(unknown).toEqual([]);
  });

  it.each(all)('$name produces a non-empty timeline', ({ name, raw }) => {
    const r = loadFixture(name, raw);
    expect(r.blocks.length + r.actions.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles('conversations'))(
    'conversation $name emits one action per dispatched line',
    ({ name, raw }) => {
      const dispatched = raw.split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .filter((l) => JSON.parse(l).type !== 'text');
      expect(loadFixture(name, raw).actions).toHaveLength(dispatched.length);
    },
  );
});
