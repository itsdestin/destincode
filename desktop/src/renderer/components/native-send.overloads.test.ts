import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendChatMessage } from './native-send';
import type { NativeSendResult } from '../../shared/types';

// WHY this file lives in src/ and not tests/: tsconfig.json's `include` is
// `src/**/*` only, so nothing under tests/ is type-checked by `tsc --noEmit`.
// The regression this pins (ROADMAP L732) is a TYPE error — a non-literal
// provider argument matched no overload — so the pin has to be a call that tsc
// sees. Runtime assertions below keep it a real test as well.
describe('sendChatMessage accepts a non-literal provider (ROADMAP L732)', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      claude: {
        native: { send: vi.fn(async () => ({ status: 'sent' }) as NativeSendResult) },
        session: { sendInput: vi.fn() },
      },
    };
  });

  it('compiles with a variable typed as the provider union and routes by value', async () => {
    const providers: Array<'claude' | 'native' | undefined> = ['native', 'claude', undefined];
    for (const provider of providers) {
      // The load-bearing line: `provider` is the UNION here, not a literal.
      // Before the widening overload this did not type-check at all.
      const r: Promise<NativeSendResult> | void = sendChatMessage(provider, 's1', 'hi');
      if (provider === 'native') {
        expect(r).toBeInstanceOf(Promise);
        await expect(r).resolves.toEqual({ status: 'sent' });
      } else {
        expect(r).toBeUndefined();
      }
    }
    expect((window as any).claude.native.send).toHaveBeenCalledTimes(1);
    expect((window as any).claude.session.sendInput).toHaveBeenCalledTimes(2);
  });

  it('still gives a literal native caller a plain Promise (no `| void`)', async () => {
    // If the literal overload ever stopped winning, this assignment would fail
    // to compile — `void` is not assignable to Promise<NativeSendResult>.
    const r: Promise<NativeSendResult> = sendChatMessage('native', 's1', 'hi');
    await expect(r).resolves.toEqual({ status: 'sent' });
  });
});
