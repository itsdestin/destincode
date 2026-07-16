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
import { NATIVE_TOOL_NAMES } from '../src/shared/harness-manifest';

describe('tool registry ↔ manifest parity', () => {
  const registered = CORE_TOOLS.map((t) => t.name).sort();
  const advertised = [...NATIVE_TOOL_NAMES].sort();

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
