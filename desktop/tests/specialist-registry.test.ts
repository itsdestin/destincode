import { describe, it, expect } from 'vitest';
import { resolveSpecialist, listSpecialists } from '../src/main/harness/specialists/registry';
import { NATIVE_TOOL_NAMES } from '../src/shared/harness-manifest';

describe('specialist registry', () => {
  it('resolves the four built-ins with coherent charters', () => {
    for (const id of ['explorer', 'worker', 'reviewer', 'researcher']) {
      const d = resolveSpecialist(id);
      expect(d).toBeDefined();
      expect(d!.allowedTools).not.toContain('Task');            // depth-by-omission, spec §1
      expect(d!.allowedTools).not.toContain('TodoWrite');       // noise tool, denied by default
      expect(d!.allowedTools).not.toContain('AskUserQuestion'); // children have no user; an interactive
                                                                  // ask from a child would hang (Task 5.5)
    }
    expect(resolveSpecialist('explorer')!.charter).toBe('read-only');
    expect(resolveSpecialist('explorer')!.allowedTools).not.toContain('Write');
    expect(resolveSpecialist('worker')!.charter).toBe('read-write');
    expect(resolveSpecialist('reviewer')!.charter).toBe('read-only');
  });

  it('returns undefined for unknown ids (caller renders the typed error)', () => {
    expect(resolveSpecialist('nonexistent')).toBeUndefined();
  });

  it('every allowedTools entry is a member of NATIVE_TOOL_NAMES', () => {
    // Guards against a typo'd tool name silently granting nothing (or the wrong
    // thing) at Task-tool wiring time (Task 5) — this is the earliest point a
    // mismatch is mechanically catchable.
    for (const d of listSpecialists()) {
      for (const tool of d.allowedTools) {
        expect(NATIVE_TOOL_NAMES).toContain(tool);
      }
    }
  });

  it('no builtin specialist is granted SendUserFile — a specialist reports to its parent, not the user', () => {
    for (const d of listSpecialists()) expect(d.allowedTools).not.toContain('SendUserFile');
  });

  it('listSpecialists returns all four built-ins', () => {
    const ids = listSpecialists().map((d) => d.id).sort();
    expect(ids).toEqual(['explorer', 'researcher', 'reviewer', 'worker']);
  });
});
