import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { plainMessage } from '../src/renderer/utils/ipc-error';

// The user-visible property: whatever main or the engine actually SAID reaches
// the screen, and none of the transport's machinery does.
describe('plainMessage', () => {
  it('strips the Electron wrapper and keeps the engine’s own line verbatim', () => {
    const raw = new Error(
      "Error invoking remote method 'models:set-settings': Error: error: invalid argument: --gpu-layers 99x",
    );
    // Verbatim matters: only the binary knows which option it refused, so the
    // dialog must not paraphrase it (design §J).
    expect(plainMessage(raw)).toBe('error: invalid argument: --gpu-layers 99x');
  });

  it('turns the remote/phone rejection into a sentence, not a channel name', () => {
    expect(plainMessage(new Error('remote-unsupported: models:settings')))
      .toBe("The local model manager isn't available via remote access yet.");
    expect(plainMessage(new Error('remote-unsupported: engine:prereqs')))
      .toBe("The local engine isn't available via remote access yet.");
  });

  it('leaves an already-plain message alone', () => {
    expect(plainMessage(new Error('Context length must be at least 1024 tokens.')))
      .toBe('Context length must be at least 1024 tokens.');
  });

  it('uses the caller’s fallback when the failure said nothing', () => {
    // Never guess a cause: a failure with no message gets the caller's own
    // non-committal line, not an invented one (docs/error-message-standards.md).
    expect(plainMessage(new Error(''), 'Could not save.')).toBe('Could not save.');
    expect(plainMessage(undefined, 'Could not save.')).toBe('Could not save.');
    expect(plainMessage({}, 'Could not save.')).toBe('Could not save.');
  });
});

// The reason this helper is a module and not a function inside one component:
// three call sites shipped without it while it lived in EngineCard.tsx.
describe('every bridge catch in the local-engine surfaces uses it', () => {
  const files = [
    'src/renderer/components/EngineCard.tsx',
    'src/renderer/components/LocalModelsSection.tsx',
    'src/renderer/components/RuntimeBinding.tsx',
  ];
  it('none of them fall back to a raw e.message', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/e instanceof Error \? e\.message/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
