import { describe, it, expect } from 'vitest';
import { childAskPolicy } from '../src/main/harness/specialists/child-ask-policy';

describe('childAskPolicy', () => {
  it('denies a max_steps ask (turn finalizes with stopReason max_steps — a clean end, not a hang)', async () => {
    const policy = childAskPolicy();
    const d = await policy({ sessionId: 'c1', toolName: 'max_steps', toolInput: { steps: 25 }, denyListed: false });
    expect(d.behavior).toBe('deny');
  });

  it('denies a doom_loop ask (the loop returns its corrective retry text to the model)', async () => {
    const policy = childAskPolicy();
    const d = await policy({ sessionId: 'c1', toolName: 'doom_loop', toolInput: { repeated: 'Grep' }, denyListed: false });
    expect(d.behavior).toBe('deny');
  });

  it('denies any other ask (external-directory, unexpected interactive) — never resolves late, never hangs', async () => {
    const policy = childAskPolicy();
    const d = await policy({ sessionId: 'c1', toolName: 'Read', toolInput: { file_path: '/outside' }, denyListed: false });
    expect(d.behavior).toBe('deny');
  });
});
