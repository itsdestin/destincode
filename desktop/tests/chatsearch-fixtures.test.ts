// A hand-typed fixture table can drift from the real chatsearch.js column
// format (padEnd widths, the two-space column join, the marker glyphs) with
// NO visible symptom other than a card that quietly fails to render — that
// is exactly how the brief's original `zzzz` row (not hex, rejected by
// FIND_ROW_RE before it ever reached resolution) would have shipped silently.
// This test loads the real tool-gallery .jsonl fixtures and runs them through
// the actual Task 1 parser, so a fixture that no longer parses fails HERE
// instead of as a missing card nobody notices in the workbench.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeChatsearchCall } from '../src/shared/chatsearch-refs';
import type { ToolCallState } from '../src/shared/types';

const FIXTURE_DIR = join(__dirname, '../src/renderer/dev/workbench/fixtures/tools');

/** A tool-gallery fixture is exactly two JSONL lines: a tool_use and its
 *  matching tool_result (see fixture-loader.ts). Reads both and builds the
 *  same ToolCallState shape the real chat reducer would produce, so this test
 *  exercises describeChatsearchCall the way ToolCard actually calls it. */
function loadToolFixture(name: string): ToolCallState {
  const raw = readFileSync(join(FIXTURE_DIR, `${name}.jsonl`), 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const use = JSON.parse(lines[0]) as { name: string; input: { command: string } };
  const result = JSON.parse(lines[1]) as { content: string; is_error?: boolean };
  return {
    toolUseId: 't1',
    toolName: use.name,
    input: use.input,
    status: 'complete', // Never 'completed' — see Global Constraints.
    response: result.content,
  };
}

describe('chatsearch tool-gallery fixtures parse as intended', () => {
  it('chatsearch-find.jsonl yields exactly the eight expected short ids, in order', () => {
    const call = describeChatsearchCall(loadToolFixture('chatsearch-find'));
    expect(call).toEqual({
      cmd: 'find',
      // The words the model actually searched for, read off the request it
      // sent the CLI — the card prints these where "Raw output" used to be.
      query: 'sync',
      shortIds: ['a3f2', '9c14', '1b07', '5e11', '7a21', 'c0de', 'ee00', 'dead'],
    });
  });

  it('chatsearch-show.jsonl yields the expected full uuid and provider', () => {
    const call = describeChatsearchCall(loadToolFixture('chatsearch-show'));
    expect(call).toEqual({
      cmd: 'show',
      id: 'a3f2aaaa-1111-4111-8111-111111111111',
      provider: 'claude',
    });
  });

  it('chatsearch-find-piped.jsonl is "not a card" (the trailing pipe means the output may be partial)', () => {
    const call = describeChatsearchCall(loadToolFixture('chatsearch-find-piped'));
    expect(call).toBeNull();
  });
});
