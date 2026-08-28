// Ledger items from docs/active/investigations/2026-08-26-native-tools-vs-other-harnesses.md
// (batches A + B). Each `describe` names the ledger id it pins. Wording pins
// assert the NEW sentence is present and the OLD one absent — the description
// is the only place a model learns a tool's rules before it trips one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/main/harness/tools/read';
import { WriteTool } from '../src/main/harness/tools/write';
import { EditTool } from '../src/main/harness/tools/edit';
import { BashTool } from '../src/main/harness/tools/bash';
import { WebFetchTool } from '../src/main/harness/tools/web-fetch';
import type { ToolContext } from '../src/main/harness/tools/types';

let dir: string;
let ctx: ToolContext;

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-polish-'));
  ctx = makeCtx(dir);
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Batch A — wording
// ---------------------------------------------------------------------------

describe('D-1: Bash no longer tells the model to re-run through head/tail/grep', () => {
  // WHY: there is no `pipefail`, so `npm test | tail -50` reports tail's exit 0
  // and hides a failing test run — the same description already warns there is
  // no `set -e`. The saved full-output file is the honest way to see more.
  it('the description drops the pipe advice and gives the redirect-and-echo-exit shape instead', () => {
    const d = BashTool.description;
    expect(d).not.toMatch(/piped through head\/tail\/grep/);
    expect(d).toMatch(/redirect/i);
    expect(d).toMatch(/echo exit=/);
    expect(d).toMatch(/pipefail/);
  });

  it('a truncated result no longer advises piping the original command', async () => {
    const r = await BashTool.execute(
      { command: `node -e "for(let i=1;i<=120;i++)console.log('L'+i)"` },
      ctx,
    );
    expect((r as any).truncated).toBe(true);
    expect(r.text).not.toMatch(/pipe the ORIGINAL command through head\/tail\/grep/);
    expect(r.text).toMatch(/Read that file/);
  });
});

describe('D-4: the read-gate refusal names a session resume as a cause', () => {
  // WHY: readRegistry resets on resume (types.ts), so the first Edit after
  // resuming is always refused with "not Read in this session" — true, but the
  // model's own memory says it DID read the file, so without this clause it
  // argues instead of re-reading.
  it('Edit says so', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resum/i);
  });

  it('Write says so on its overwrite path', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resum/i);
  });
});

describe('D-6: WebFetch has no `prompt` parameter', () => {
  // WHY: it was only ever echoed back as a header ("Fetched for: …"), which
  // invites the model to expect an answer that never comes.
  it('the schema no longer accepts it and the description does not mention it', () => {
    const shape = (WebFetchTool.inputSchema as any).shape ?? {};
    expect(Object.keys(shape)).not.toContain('prompt');
    expect(WebFetchTool.description).not.toMatch(/\bprompt\b/);
  });
});

describe('G-4: Edit parameters carry descriptions', () => {
  const shape = () => (EditTool.inputSchema as any).shape as Record<string, { description?: string }>;

  it('every parameter is described', () => {
    for (const key of ['file_path', 'old_string', 'new_string', 'replace_all']) {
      expect(shape()[key]?.description, key).toBeTruthy();
    }
  });

  it('old_string warns about the Read line-number prefix and asks for a minimal anchor', () => {
    const d = shape().old_string.description!;
    expect(d).toMatch(/exactly once|unique/i);
    expect(d).toMatch(/line.number/i);   // "line-number prefix" / "line number"
    expect(d).toMatch(/tab/i);
    expect(d).toMatch(/1.3 lines/);
  });
});

describe('G-13: Bash steers the model to the dedicated tools', () => {
  it('names Read/Grep/Glob/Edit as the alternatives to cat/grep/find/sed', () => {
    const d = BashTool.description;
    expect(d).toMatch(/Read \(not cat\/head\/tail\)/);
    expect(d).toMatch(/Grep \(not grep\/rg\)/);
    expect(d).toMatch(/Glob \(not find\/ls\)/);
    expect(d).toMatch(/Edit \(not sed\/awk\)/);
    expect(d).toMatch(/Edit only accepts files seen via Read/);
  });
});

describe('T-3: Read carries a token-frugality nudge and states both caps', () => {
  it('both full variants say to read only the part you need, and name the ~50 KB cap', () => {
    const textOnly = ReadTool.description;
    const vision = ReadTool.descriptionFor!({ supportsVision: true })!;
    for (const d of [textOnly, vision]) {
      expect(d).toMatch(/When you already know which part you need, read only that part/);
      expect(d).toMatch(/2000 lines or ~50 KB, whichever comes first/);
    }
  });

  it('the short description stays short (small-model variant)', () => {
    expect(ReadTool.shortDescription!.length).toBeLessThan(120);
    expect(ReadTool.shortDescription).not.toMatch(/already know which part/);
  });
});
