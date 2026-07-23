import { describe, it, expect } from 'vitest';
import { buildKeepAboveScript } from '../src/main/kwin-keep-above';

// Pure script-text builder only — applyKwinKeepAbove's subprocess half
// follows the codebase's untested-side-effect pattern (no test; see other
// child_process call sites like remote-config.ts's tailscale detection).
describe('buildKeepAboveScript', () => {
  it('true variant: iterates workspace.windowList(), filters on the exact caption, sets keepAbove = true', () => {
    const script = buildKeepAboveScript('YouCoded Buddy', true);
    expect(script).toContain('workspace.windowList()');
    // Exact-caption filter — matches the JSON-escaped title, not a bare
    // string-interpolated one (see the injection-safety test below).
    expect(script).toContain(JSON.stringify('YouCoded Buddy'));
    expect(script).toMatch(/w\.caption\s*===\s*"YouCoded Buddy"/);
    expect(script).toMatch(/keepAbove\s*=\s*true/);
  });

  it('false variant sets keepAbove = false', () => {
    const script = buildKeepAboveScript('YouCoded Buddy', false);
    expect(script).toMatch(/keepAbove\s*=\s*false/);
    expect(script).not.toMatch(/keepAbove\s*=\s*true/);
  });

  it('never string-interpolates the title unescaped — a quote-bearing title stays JSON-escaped', () => {
    // A raw, unescaped interpolation of this title would break out of the
    // generated string literal and inject arbitrary KWin script code.
    const evil = 'a" ; workspace.windowList()[0].closeWindow(); //';
    const script = buildKeepAboveScript(evil, true);
    // The JSON.stringify'd form (escaped quote) must appear...
    expect(script).toContain(JSON.stringify(evil));
    // ...and the naive unescaped interpolation must NOT appear anywhere.
    expect(script).not.toContain(`"${evil}"`);
  });
});
