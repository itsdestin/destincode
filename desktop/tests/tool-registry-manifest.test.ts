// Guard: the registered CORE_TOOLS set and the manifest's advertised
// NATIVE_TOOL_NAMES must stay in lockstep. WHY: presets advertise their tool
// suite via NATIVE_TOOL_NAMES, and the Assistant/Coder prompt bodies name tools
// by that list; if a name is advertised but not registered in CORE_TOOLS, a
// preset instructs the model to call a tool that doesn't exist (hallucinated
// calls / dead capability). If a tool is registered but not advertised, it
// ships invisibly. This test makes either drift a build failure. (Flagged during
// the Plan B Task 13 review, where the manifest briefly listed WebSearch/
// AskUserQuestion before they were registered.)
import { describe, it, expect } from 'vitest';
import { CORE_TOOLS } from '../src/main/harness/tools';
import { NATIVE_TOOL_NAMES, CONDITIONAL_TOOL_NAMES } from '../src/shared/harness-manifest';
import { createSkillTool } from '../src/main/harness/tools/skill';

const registered = CORE_TOOLS.map((t) => t.name).sort();
const advertised = [...NATIVE_TOOL_NAMES].sort();

describe('tool registry ↔ manifest parity', () => {

  it('every advertised NATIVE_TOOL_NAME is a registered CORE_TOOL', () => {
    const missing = advertised.filter((name) => !registered.includes(name));
    expect(missing, `advertised but NOT registered: ${missing.join(', ')}`).toEqual([]);
  });

  it('every registered CORE_TOOL is advertised in NATIVE_TOOL_NAMES', () => {
    const unadvertised = registered.filter((name) => !advertised.includes(name));
    expect(unadvertised, `registered but NOT advertised: ${unadvertised.join(', ')}`).toEqual([]);
  });

  it('registered tool names are unique (no accidental double-registration)', () => {
    expect(registered.length).toBe(new Set(registered).size);
  });

  it('the two sets are exactly equal', () => {
    expect(registered).toEqual(advertised);
  });
});

// Conditional tools are the exception this guard's rule implies. `Skill` is
// attached per session only when the capability profile can afford its catalog
// and skills are actually installed — so advertising it statically would commit
// the very sin above: telling the model about a tool that, on a small local model
// or a machine with no skills, is not attached.
describe('conditional tools stay OUT of the advertised set', () => {
  it('Skill is not advertised — its existence depends on the model', () => {
    expect([...NATIVE_TOOL_NAMES]).not.toContain('Skill');
  });

  it('Skill is not a static CORE_TOOL either — it needs a runtime catalog', () => {
    expect(CORE_TOOLS.map((t) => t.name)).not.toContain('Skill');
  });

  it('but it IS implemented — conditional must not mean absent', () => {
    // Without this, "not in either list" would also describe a Skill tool that
    // was never written, and the two assertions above would pass on nothing.
    const tool = createSkillTool({ list: () => [{ id: 'x', description: 'd' }], load: () => { throw new Error('unused'); } });
    expect(tool.name).toBe('Skill');
  });

  it('every conditional name is genuinely absent from the advertised set', () => {
    for (const name of CONDITIONAL_TOOL_NAMES) expect(advertised).not.toContain(name);
  });
});
