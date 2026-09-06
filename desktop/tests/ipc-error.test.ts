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
//
// WHY the check is PROPERTY-shaped and not idiom-shaped: the first version
// matched the single string `e instanceof Error ? e.message`, so
// `e?.message ?? 'Could not save.'` — the same bug, one spelling away — was
// green, and so was renaming the variable to `err`. What actually has to be
// true is that NO caught error's message reaches the screen unstripped, in any
// spelling, so the rule is about `.message` inside a catch block.
describe('no bridge failure reaches the screen wearing its wrapper', () => {
  const files = [
    'src/renderer/components/EngineCard.tsx',
    'src/renderer/components/LocalModelsSection.tsx',
    'src/renderer/components/RuntimeBinding.tsx',
    'src/renderer/components/ProvidersSection.tsx',
  ];

  /** Every `catch (…) { … }` body in a file, by brace matching. */
  function catchBodies(src: string): Array<{ line: number; body: string }> {
    const out: Array<{ line: number; body: string }> = [];
    const re = /\bcatch\s*(\([^)]*\))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
      }
      out.push({
        line: src.slice(0, m.index).split('\n').length,
        body: src.slice(m.index + m[0].length, i - 1),
      });
    }
    return out;
  }

  // Sanity: a scan that matched nothing would pass vacuously forever.
  it('the catch scan actually finds catch blocks', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', files[1]), 'utf8');
    expect(catchBodies(src).length).toBeGreaterThan(3);
    expect(catchBodies("try { a(); } catch (e) { show(e.message); }")[0].body).toContain('e.message');
  });

  it('no catch block in these files reads a .message directly', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const { line, body } of catchBodies(src)) {
        // Comments explain WHY plainMessage is used and legitimately say
        // "e.message"; only code counts.
        const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        if (/\.message\b/.test(code)) offenders.push(`${f}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
