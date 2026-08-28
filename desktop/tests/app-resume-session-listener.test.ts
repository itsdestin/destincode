import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Guard for the youcoded:resume-session listener (spec
// 2026-08-26-conversation-preview-header-design.md A2, plan Task 12 pulled
// forward). App.tsx is 3600+ lines and mounting it in a test requires the
// full renderer boot sequence (PTY host, remote server, localStorage under
// jsdom's default origin, dozens of window.claude channels) — a spike to
// mount the real component against the workbench's own mock shim got as far
// as the buddy-window effect before hitting an unrelated jsdom localStorage
// gap, which is exactly the kind of unrelated failure app-quit-routes.test.ts
// (main.ts) already accepted this same tradeoff for. So, like that file, this
// pins the invariant against the SOURCE TEXT rather than a live mount — a
// weaker guard (it proves the listener is wired correctly, not that clicking
// Resume in a running app ends in a new tab), but a real one: the component-
// level test (tests/session-drawer-preview-header.test.tsx) already proves
// the CustomEvent itself carries the right payload when Resume is clicked;
// this proves the OTHER end reads that payload correctly and hands it to
// handleResumeSession untouched.
describe('App.tsx: youcoded:resume-session listener', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

  it('registers a listener for the event SessionRefActions.requestResume (and the preview header) dispatch', () => {
    expect(src).toMatch(/window\.addEventListener\('youcoded:resume-session', onResume\)/);
    expect(src).toMatch(/window\.removeEventListener\('youcoded:resume-session', onResume\)/);
  });

  it('bails when the detail is missing any of the three required fields, before calling handleResumeSession', () => {
    // The guard clause must run BEFORE the call, and must check all three —
    // a payload with a hole must never reach handleResumeSession's
    // positional arguments.
    // `\s*`, not `\n\s*`: a Windows checkout has CRLF line endings, so a
    // literal \n never matched, the capture fell through to '', and the
    // assertion below reported "expected '' to match" — a source-scanning test
    // that silently measures nothing on one platform.
    const onResumeBody = /const onResume = \(e: Event\) => \{([\s\S]*?)\};\s*window\.addEventListener/.exec(src)?.[1] ?? '';
    expect(onResumeBody).not.toBe('');
    expect(onResumeBody).toMatch(/if \(!d\?\.claudeSessionId \|\| !d\.projectSlug \|\| !d\.projectPath\) return;/);
    // The guard must appear textually before the call it's guarding.
    const guardIdx = onResumeBody.indexOf('if (!d?.claudeSessionId');
    const callIdx = onResumeBody.indexOf('handleResumeSession(');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(guardIdx);
  });

  it('passes the popover\'s model/skip-permissions through, and keeps launchInNewWindow undefined', () => {
    // Positional: (claudeSessionId, projectSlug, projectPath, resumeModel,
    // resumeDangerous, launchInNewWindow, provider, nativeBinding). The
    // spec (A2, Destin: "not new 'window' just new tab in session") requires
    // launchInNewWindow (arg 6) to be explicitly undefined, not omitted —
    // omitting it would read the same at the call site but is the harder
    // invariant to keep true across a future signature change, so pin the
    // literal. Args 4/5/8 carry what the preview header's Resume popover
    // collected (2026-08-27 gate, M-header); a search row sends none of them
    // and they arrive undefined, which is the behaviour this used to pin.
    expect(src).toMatch(
      /handleResumeSession\(d\.claudeSessionId, d\.projectSlug, d\.projectPath, d\.model, d\.dangerous, undefined, d\.provider, d\.binding\)/,
    );
  });

  it('is declared AFTER handleResumeSession — a TDZ constraint, documented at the call site', () => {
    // The listener closes over a `const` declared with useCallback. Registering
    // it above that declaration throws at module evaluation, which is why it
    // does not sit with App's other custom-event listeners near the top.
    // (This used to anchor on youcoded:open-library's listener as "the other
    // listeners"; master removed that one, so the assertion measured a -1 and
    // passed vacuously on the sign. Anchor on the declaration itself instead —
    // that IS the constraint.)
    const resumeListenerIdx = src.indexOf("addEventListener('youcoded:resume-session'");
    const handleResumeDeclIdx = src.indexOf('const handleResumeSession = useCallback');
    expect(handleResumeDeclIdx).toBeGreaterThan(0);
    expect(resumeListenerIdx).toBeGreaterThan(handleResumeDeclIdx);
  });
});
