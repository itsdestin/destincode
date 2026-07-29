// Task 10 — profile-driven simplified tool presentation. A 'simplified' profile
// (small local models) must hand the model each tool's COMPACT shortDescription
// instead of its full description, while keeping ALL ten tools present; a 'full'
// profile keeps the rich descriptions. buildAiTools() is the single seam that
// decides this, so we assert on its output directly.
//
// makeSession already accepts a `tools` override; we pass the REAL CORE_TOOLS set
// (10 tools incl. WebSearch) so the assertions run against production tools, not
// the fake Glob+Read default.
import { describe, it, expect } from 'vitest';
import { makeSession } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { CORE_TOOLS } from '../src/main/harness/tools';

describe('simplified tool presentation', () => {
  it('simplified profile hands the model compact descriptions; all ten tools stay present', () => {
    const simplified = (makeSession({ tools: CORE_TOOLS, profile: { ...CLOUD_DEFAULT, maxToolPresentation: 'simplified' } }) as any).buildAiTools();
    const full = (makeSession({ tools: CORE_TOOLS, profile: CLOUD_DEFAULT }) as any).buildAiTools();
    // All ten tools survive the simplified presentation — we compact wording, never drop a tool.
    expect(Object.keys(simplified)).toContain('WebSearch');
    expect(Object.keys(simplified)).toHaveLength(10);
    // WebSearch is one of the richest-schema tools: its simplified description is
    // the compact shortDescription, strictly shorter than the full one and well
    // under 200 chars. (This is what fails before shortDescription exists — the
    // simplified path would otherwise echo the full description verbatim.)
    expect((simplified.WebSearch.description as string).length).toBeLessThan(200);
    expect((simplified.WebSearch.description as string).length).toBeLessThan((full.WebSearch.description as string).length);
    // The 7 CORE tools must ALSO shrink under simplified presentation — before
    // they got a shortDescription they fell back to the full description, so a
    // small local model still saw the full schema (the feature was hollow). Bash
    // is the canary: its simplified form must be strictly shorter than its full one.
    expect((simplified.Bash.description as string).length).toBeLessThan((full.Bash.description as string).length);
  });
  it('full profile keeps rich descriptions and all ten tools', () => {
    expect(Object.keys((makeSession({ tools: CORE_TOOLS, profile: CLOUD_DEFAULT }) as any).buildAiTools())).toHaveLength(10);
  });
});
