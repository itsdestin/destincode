// M6 item 3 — the project-instruction budget.
//
// Until 2026-08-10 `prompt-assembly.ts` cut project instructions with a bare
// `.slice(0, 20_000)`: a CHARACTER count in a subsystem where every other budget
// counts TOKENS, applied identically to a frontier model and an 8k local one,
// cutting at a byte offset, and saying nothing.
//
// The replacement does NOT simply cut the bottom half off. A model that cannot
// see a section cannot know to go read it, so the OUTLINE is the floor: every
// heading survives at every budget. What scales is how much body text sits under
// those headings — full text from the top while there is room, then heading-plus-
// first-lines for the rest. The model always knows the file's full shape and can
// Read the parts it needs.
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

// A markdown instruction file with `sections` H2 sections. Each body is a
// distinctive first line followed by bulk, so tests can tell a preview (first
// line present, bulk absent) from a full section (both present).
function md(sections: number, bulkChars = 400): string {
  const out: string[] = ['# Project', '', 'Intro paragraph.', ''];
  for (let i = 1; i <= sections; i++) {
    out.push(`## Section ${i}`, '', `First line of ${i}.`, '', 'x'.repeat(bulkChars), '');
  }
  return out.join('\n');
}

const headingsIn = (s: string) => s.split('\n').filter((l) => /^#{1,6} /.test(l));

describe('fitProjectInstructions — token budget', () => {
  it('returns the text untouched when it fits', () => {
    const text = md(2);
    const r = fitProjectInstructions(text, 20_000, 'AGENTS.md');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
  });

  it('scales with the budget it is given, not a fixed character count', () => {
    // The old 20k-CHARACTER cap produced identical output for a frontier model
    // and an 8k local one. That is the bug this file exists for.
    const text = md(40);
    const small = fitProjectInstructions(text, 2_000, 'AGENTS.md');
    const large = fitProjectInstructions(text, 20_000, 'AGENTS.md');
    expect(small.truncated).toBe(true);
    expect(large.truncated).toBe(false);
    expect(small.text.length).toBeLessThan(large.text.length);
  });

  it('never exceeds the budget it was given', () => {
    for (const budget of [400, 1_000, 3_000]) {
      const r = fitProjectInstructions(md(60), budget, 'CLAUDE.md');
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(budget * 4);
    }
  });
});

describe('fitProjectInstructions — the outline is the floor', () => {
  it('keeps EVERY heading even at a budget far below the file size', () => {
    // The whole point: 21 headings still name 21 sections. A model that cannot
    // see a section cannot know to go read it.
    const text = md(20);
    const r = fitProjectInstructions(text, 500, 'CLAUDE.md');
    expect(r.truncated).toBe(true);
    expect(headingsIn(r.text)).toEqual(headingsIn(text));
  });

  it('keeps every heading across a wide range of budgets', () => {
    const text = md(30);
    const all = headingsIn(text);
    for (const budget of [300, 600, 1_200, 2_400]) {
      expect(headingsIn(fitProjectInstructions(text, budget, 'AGENTS.md').text)).toEqual(all);
    }
  });

  it('gives the leading sections their full body and outlines the rest', () => {
    const text = md(30);
    const r = fitProjectInstructions(text, 1_500, 'CLAUDE.md');
    // Section 1 is full: its bulk survives. A late section is outlined: its
    // first line survives but its bulk does not.
    expect(r.text).toContain('First line of 1.');
    expect(r.text).toContain('x'.repeat(400));
    expect(r.text).toContain('## Section 30');
    const late = r.text.slice(r.text.indexOf('## Section 30'));
    expect(late).not.toContain('x'.repeat(400));
  });

  it('marks outlined sections so full and outlined are distinguishable', () => {
    const r = fitProjectInstructions(md(30), 1_500, 'CLAUDE.md');
    expect(r.text).toContain('…');
  });

  it('gives richer previews when the budget allows', () => {
    // Same file, more budget → outlined sections carry more of their body.
    // Sections here are many and small, so budget goes to preview depth rather
    // than to promoting whole sections to full.
    const text = md(60, 40);
    const lean = fitProjectInstructions(text, 700, 'AGENTS.md');
    const rich = fitProjectInstructions(text, 1_000, 'AGENTS.md');
    expect(lean.truncated && rich.truncated).toBe(true);
    expect(rich.text.length).toBeGreaterThan(lean.text.length);
  });
});

describe('fitProjectInstructions — announces what it did', () => {
  it('names the file and says the outlined sections are readable there', () => {
    const r = fitProjectInstructions(md(30), 1_500, 'AGENTS.md');
    expect(r.text).toContain('AGENTS.md');
    expect(r.text).toMatch(/\d+ of \d+ sections/);
  });

  it('never claims sections were omitted when they are merely outlined', () => {
    // The earlier draft of this fix said "15 of 21 sections omitted" — false
    // once every heading survives, and it invites the model to give up on them.
    const r = fitProjectInstructions(md(30), 1_500, 'CLAUDE.md');
    expect(r.text).not.toContain('omitted');
  });

  it('is honest when the outline itself does not fit', () => {
    // Only path where content truly disappears: so many headings that naming
    // them all blows the budget. It must say so rather than imply completeness.
    const r = fitProjectInstructions(md(400, 10), 200, 'CLAUDE.md');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(200 * 4);
    expect(r.text).toContain('omitted');
  });
});

describe('fitProjectInstructions — files with no headings', () => {
  it('falls back to a bounded head cut and still names the file', () => {
    const r = fitProjectInstructions('y'.repeat(50_000), 500, 'AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(500 * 4);
    expect(r.text).toContain('AGENTS.md');
    expect(r.text).not.toMatch(/\d+ of \d+ sections/);
  });

  it('prefers a line boundary over a byte offset when one is in range', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'w'.repeat(50)}`).join('\n');
    const r = fitProjectInstructions(text, 500, 'CLAUDE.md');
    const body = r.text.slice(0, r.text.indexOf('[...'));
    const src = new Set(text.split('\n'));
    for (const line of body.split('\n')) {
      if (line === '') continue;
      expect(src.has(line)).toBe(true);
    }
  });

  it('yields the notice alone when the budget cannot hold even that', () => {
    // Never a bare empty string a caller would read as "this project has no
    // instructions" — same contract as fitInjection.
    const r = fitProjectInstructions(md(10), 1, 'AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.text.trim().length).toBeGreaterThan(0);
  });
});

describe('assembleSystemPrompt — wires the budget through', () => {
  it('applies the caller-supplied budget and keeps the block terminated', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), md(30));
    const out = assembleSystemPrompt({
      presetBody: PRESET, cwd: dir, appVersion: '1.0.0', instructionBudgetTokens: 1_500,
    });
    expect(out).toContain('<project-instructions');
    expect(out).toContain('## Section 30');
    // The budget bounds the FILE BODY, not the tag that labels it, or a cut
    // would leave <project-instructions> unterminated.
    expect(out).toContain('</project-instructions>');
  });

  it('leaves a file that fits the budget completely unmarked', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), md(2));
    const out = assembleSystemPrompt({
      presetBody: PRESET, cwd: dir, appVersion: '1.0.0', instructionBudgetTokens: 20_000,
    });
    expect(out).toContain('## Section 2');
    expect(out).not.toContain('…');
  });

  it('stays byte-stable across two calls with the same budget (KV-cache pin)', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), md(30));
    const inputs = { presetBody: PRESET, cwd: dir, appVersion: '1.0.0', instructionBudgetTokens: 1_500 };
    expect(assembleSystemPrompt(inputs)).toBe(assembleSystemPrompt(inputs));
  });
});
