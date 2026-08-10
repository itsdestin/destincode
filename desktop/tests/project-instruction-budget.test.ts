// M6 item 3 — the project-instruction cap.
//
// Until 2026-08-10 `prompt-assembly.ts` cut project instructions with a bare
// `.slice(0, 20_000)`: a CHARACTER count in a subsystem where every other budget
// counts TOKENS, applied identically to a frontier model and an 8k local one,
// cutting at a byte offset (mid-sentence, mid-code-block), and saying nothing.
// These tests pin the three properties that replaced it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemPrompt } from '../src/main/harness/prompt-assembly';
import { fitProjectInstructions } from '../src/main/harness/injection/injection-budget';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-budget-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const PRESET = 'PRESET_BODY_MARKER';

// A markdown instruction file with `sections` H2 sections, each `bodyChars` long.
function md(sections: number, bodyChars: number): string {
  const out: string[] = ['# Project', '', 'Intro paragraph.', ''];
  for (let i = 1; i <= sections; i++) {
    out.push(`## Section ${i}`, '', 'x'.repeat(bodyChars), '');
  }
  return out.join('\n');
}

describe('fitProjectInstructions — token budget', () => {
  it('returns the text untouched when it fits', () => {
    const text = md(2, 100);
    const r = fitProjectInstructions(text, 20_000, 'AGENTS.md');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
  });

  it('scales with the budget it is given, not a fixed character count', () => {
    // The same file against a small-local budget and a frontier one. The old
    // 20k-CHARACTER cap produced identical output for both; that is the bug.
    const text = md(40, 400);
    const small = fitProjectInstructions(text, 2_000, 'AGENTS.md');
    const large = fitProjectInstructions(text, 20_000, 'AGENTS.md');
    expect(small.truncated).toBe(true);
    expect(large.truncated).toBe(false);
    expect(small.text.length).toBeLessThan(large.text.length);
  });

  it('never exceeds the budget it was given', () => {
    const text = md(60, 500);
    const budgetTokens = 1_000;
    const r = fitProjectInstructions(text, budgetTokens, 'CLAUDE.md');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(budgetTokens * 4);
  });

  it('yields the notice alone when the budget cannot hold even that', () => {
    // Mirrors fitInjection: never a bare empty string the caller would read as
    // "this project has no instructions".
    const r = fitProjectInstructions(md(10, 500), 1, 'AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('truncated');
    expect(r.text.trim().length).toBeGreaterThan(0);
  });
});

describe('fitProjectInstructions — announces the cut', () => {
  it('says it was truncated and names the file to read for the rest', () => {
    const r = fitProjectInstructions(md(40, 400), 500, 'AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('truncated');
    expect(r.text).toContain('AGENTS.md');
  });

  it('reports how many sections were omitted', () => {
    const r = fitProjectInstructions(md(40, 400), 500, 'CLAUDE.md');
    // 41 headings total (H1 + 40 H2). The notice must name a real count, not a
    // vague "some content" — a model that knows it is missing 30 named sections
    // can go read them; one told "truncated" cannot tell how much it lost.
    expect(r.text).toMatch(/\d+ of \d+ sections omitted/);
  });

  it('omits the section count for a file with no headings', () => {
    // A plain-prose AGENTS.md has no sections to count; claiming "0 of 0" would
    // be noise, and claiming a number would be false.
    const r = fitProjectInstructions('y'.repeat(50_000), 500, 'AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.text).not.toMatch(/sections omitted/);
    expect(r.text).toContain('AGENTS.md');
  });
});

describe('fitProjectInstructions — cuts at a section boundary', () => {
  it('does not cut mid-line when a heading boundary is available', () => {
    const text = md(40, 400);
    const r = fitProjectInstructions(text, 2_000, 'AGENTS.md');
    const body = r.text.slice(0, r.text.indexOf('[...'));
    // Every retained line must be a WHOLE line from the source, so the model
    // never receives a half-sentence or a half-open code fence.
    const srcLines = new Set(text.split('\n'));
    for (const line of body.split('\n')) {
      if (line === '') continue;
      expect(srcLines.has(line)).toBe(true);
    }
  });

  it('keeps whole leading sections rather than a byte prefix', () => {
    const text = md(40, 400);
    const r = fitProjectInstructions(text, 2_000, 'AGENTS.md');
    expect(r.text).toContain('# Project');
    expect(r.text).toContain('## Section 1');
    // The last heading present must have its body intact (the next heading is
    // where the cut landed), never a heading with a chopped body under it.
    const kept = r.text.slice(0, r.text.indexOf('[...'));
    const lastHeading = kept.lastIndexOf('## Section ');
    expect(kept.slice(lastHeading)).toContain('x'.repeat(400));
  });

  it('falls back to a hard cut when no boundary exists in range', () => {
    // One enormous heading-less blob: there is no boundary to prefer, so the
    // function must still bound it rather than return it whole.
    const r = fitProjectInstructions('z'.repeat(100_000), 500, 'CLAUDE.md');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(500 * 4);
  });
});

describe('assembleSystemPrompt — wires the budget through', () => {
  it('applies the caller-supplied budget to the project-instructions block', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), md(40, 400));
    const out = assembleSystemPrompt({
      presetBody: PRESET, cwd: dir, appVersion: '1.0.0', instructionBudgetTokens: 500,
    });
    expect(out).toContain('<project-instructions');
    expect(out).toContain('truncated');
    // The closing tag must survive the cut — the budget bounds the FILE BODY,
    // not the tag that labels it, or the block would be left unterminated.
    expect(out).toContain('</project-instructions>');
  });

  it('leaves a file that fits the budget completely unmarked', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), md(2, 100));
    const out = assembleSystemPrompt({
      presetBody: PRESET, cwd: dir, appVersion: '1.0.0', instructionBudgetTokens: 20_000,
    });
    expect(out).toContain('## Section 2');
    expect(out).not.toContain('truncated');
  });

  it('stays byte-stable across two calls with the same budget (KV-cache pin)', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), md(40, 400));
    const inputs = { presetBody: PRESET, cwd: dir, appVersion: '1.0.0', instructionBudgetTokens: 500 };
    expect(assembleSystemPrompt(inputs)).toBe(assembleSystemPrompt(inputs));
  });
});
