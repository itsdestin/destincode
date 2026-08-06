// Task 19 regression pins: the gap three independent reviews found from three
// different directions. `bounds` (ResultBounds, Task 1) describes what the TOOL
// dropped; `defineTool`'s pipeline cap (registry.ts) is a SEPARATE event that
// fires on its own schedule. The three cases below are the MEASURED instances
// where only the pipeline cap fired — content-mode Grep capped by `maxLines`,
// Glob capped by `maxChars` under its own result limit, and Bash's cwd-reset
// trailer pushing a small body over the cap — each of which used to hand the
// model a bare byte count with no way to widen its next call.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrepTool } from '../src/main/harness/tools/grep';
import { GlobTool } from '../src/main/harness/tools/glob';
import { BashTool } from '../src/main/harness/tools/bash';
import type { ToolContext } from '../src/main/harness/tools/types';

// composeNotice's bare no-advice fallback (truncate.ts) — the honest shape when
// NEITHER a per-call bound NOR a tool's static `moreHint` (Task 19) is available.
// None of the cases in this file should ever produce it: each one bottoms out on
// a tool's static hint, which is exactly the gap Task 19 closes.
const BARE_NO_ADVICE = /\[output truncated: showing \d+ of \d+ chars\]/;

function assertAdviceNotBare(text: string) {
  expect(text).toContain('output truncated: showing');
  expect(text).not.toMatch(BARE_NO_ADVICE);
}

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

describe('Task 19: pipeline cap fires with no tool-declared bounds, but advice still arrives', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('content-mode Grep capped by maxLines (not maxChars) still carries widening advice', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-maxlines-'));
    // 400 matching lines in ONE file, ~6.7k chars total — the exact shape of the
    // measured case: well under Grep's own 24k retention window (so `bounds`
    // stays undefined — nothing was dropped at the byte level) but over
    // caps.maxLines: 250, so the PIPELINE cap is the ONLY one that fires.
    const lines = Array.from({ length: 400 }, (_, i) => `export const MATCH_${i} = ${i};`);
    fs.writeFileSync(path.join(dir, 'big.ts'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', output_mode: 'content' }, makeCtx(dir));
    // Confirms the actual gap: the TOOL saw nothing worth bounding.
    expect(r.bounds).toBeUndefined();
    assertAdviceNotBare(r.text);
    expect(r.text).toContain('narrow the pattern');
  });

  it('Glob capped by maxChars while hits.length <= RESULT_LIMIT still carries widening advice', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-maxchars-'));
    // Exactly 2,000 files == RESULT_LIMIT, so `hits.length > shown.length` is
    // false and Glob declares no bounds — but names long enough that the joined
    // path list exceeds caps.maxChars (30k) on sheer length alone.
    for (let i = 0; i < 2_000; i++) {
      fs.writeFileSync(path.join(dir, `moderately-long-filename-${String(i).padStart(4, '0')}.ts`), '');
    }
    const r = await GlobTool.execute({ pattern: '*.ts' }, makeCtx(dir));
    expect(r.bounds).toBeUndefined();
    assertAdviceNotBare(r.text);
    expect(r.text).toContain('narrow the glob pattern');
  }, 30_000);

  // Additional case (per the Task 19 assignment, beyond the brief's two Step-5
  // cases): the ONE instance per-tool arithmetic already missed once — bash.ts's
  // HEAD_CHARS/TAIL_CHARS rework closed the body-only overflow, but the cwd-reset
  // notice AND the metadata line both embed ctx.cwd a SECOND time, outside that
  // budget. A long workspace root can push the total past the pipeline's 30k cap
  // while Bash's own head+tail capture stays comfortably inside its 28k budget —
  // this is the argument for a STRUCTURAL fix (tool-level static hint) over
  // fixing each tool's arithmetic again, which is exactly what got missed before.
  it.skipIf(process.platform !== 'linux')(
    'Bash: a long workspace root pushes the cwd-reset trailer over the pipeline cap without Bash declaring bounds',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-longroot-'));
      // Build a REAL, deeply nested directory so ctx.cwd itself is long — this
      // reproduces the actual bug (the trailer embeds the genuine ctx.cwd, not a
      // stand-in string the tool never touches). Linux-only: PATH_MAX headroom
      // (4096) comfortably fits ~2.3k chars; macOS (1024) and Windows (MAX_PATH
      // 260) impose OS-level limits that would make this an OS-specific
      // reproduction, not evidence of the gap itself.
      let root = dir;
      const seg = 'a'.repeat(200);
      while (root.length < 2_300) {
        const next = path.join(root, seg);
        fs.mkdirSync(next);
        root = next;
      }
      const ctx = makeCtx(root);
      // 27,000 chars of stdout: under Bash's own HEAD_CHARS + TAIL_CHARS budget
      // (28,000 — see the WHY block above BashTool's HEAD_CHARS constant), so
      // Bash's own `dropped` flag stays false and `bounds` stays undefined.
      // `cd /` is genuinely outside this workspace root, so the scope guard
      // fires and both the reset notice and the metadata line embed the
      // ~2,300-char root TWICE — the thing the per-call HEAD/TAIL budget never
      // accounted for.
      const r = await BashTool.execute(
        { command: `cd / && node -e "process.stdout.write('x'.repeat(27000))"` },
        ctx,
      );
      expect(r.bounds).toBeUndefined();
      expect(r.text).toMatch(/Shell cwd was reset to/);
      assertAdviceNotBare(r.text);
      expect(r.text).toContain('pipe through head -n 100');
    },
    30_000,
  );
});
