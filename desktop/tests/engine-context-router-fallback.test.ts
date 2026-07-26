// REGRESSION: the real context window silently halved in llama-server ROUTER mode.
//
// Found 2026-07-26 dogfooding. Plan C's headline claim is that a local model's
// window is READ and enforced, never guessed — but in `--models-dir` router mode
// (the default) /props answers `{model_path: "none", n_ctx: 0}` whenever no model
// is currently resident. clampContextWindow drops any value <= 0, so it fell
// through to a hardcoded 32_768 while the server was actually serving -c 64000.
//
// Consequences were worse than "conservative": a ROADMAP.md read that fits
// comfortably in 64k overflowed the phantom 32k budget, the context trimmer
// emptied the window, and the turn died with "messages must not be empty".
import { describe, it, expect } from 'vitest';
import { clampContextWindow } from '../src/main/engine/engine-manager';

describe('clampContextWindow', () => {
  it('ignores a zero/absent live reading rather than treating it as a real window', () => {
    // This is what router-mode /props reports with nothing loaded.
    expect(clampContextWindow(0, null)).toBe(32_768);
    expect(clampContextWindow(null, null)).toBe(32_768);
  });

  it('takes the configured -c when it is passed in place of a dead live reading', () => {
    // effectiveContextWindow now feeds `loaded ?? configured`, so a router-mode
    // zero resolves to the number this app actually spawned the server with.
    expect(clampContextWindow(64_000, null)).toBe(64_000);
  });

  it('a live reading still WINS over a larger configured value', () => {
    // The server can clamp our -c down to what the model or VRAM allowed; the
    // observed number must beat the requested one, never the other way around.
    expect(clampContextWindow(8_192, 64_000)).toBe(8_192);
  });

  it('clamps to the trained maximum when that is the smaller of the two', () => {
    expect(clampContextWindow(262_144, 32_768)).toBe(32_768);
  });
});

describe('the failure this unblocks', () => {
  it('64k is enough for the ROADMAP-sized read that died at a phantom 32k', () => {
    // 100_000 chars of tool output ~= 25_000 tokens, plus a ~6_000-token system
    // prompt. Comfortable inside 64k; over budget against 32_768 once the
    // reserved output allowance is subtracted.
    const toolTokens = Math.ceil(100_000 / 4);
    const systemTokens = 6_000;
    const budget = (ctx: number) => ctx - 4_096 - 1_024;   // fitToContext's reservation

    expect(toolTokens + systemTokens).toBeGreaterThan(budget(32_768));   // what happened
    expect(toolTokens + systemTokens).toBeLessThan(budget(64_000));      // what should have
  });
});
