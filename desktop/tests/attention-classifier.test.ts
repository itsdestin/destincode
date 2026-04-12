import { describe, it, expect } from 'vitest';
import {
  classifyBuffer,
  ClassifierContext,
} from '../src/renderer/state/attention-classifier';

function ctx(lines: string[], overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    bufferTail: lines,
    previousSpinnerSeconds: null,
    secondsSincePreviousSpinner: 0,
    ...overrides,
  };
}

describe('classifyBuffer', () => {
  it('empty buffer → unknown', () => {
    expect(classifyBuffer(ctx([])).class).toBe('unknown');
  });

  it('recognizes the Claude spinner with seconds counter (first tick → active)', () => {
    const result = classifyBuffer(ctx(['', '✻ Pondering… (7s · esc to interrupt)', '']));
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerSeconds).toBe(7);
  });

  it('spinner counter advancing between ticks → active', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating… (12s · esc to interrupt)'], {
        previousSpinnerSeconds: 9,
        secondsSincePreviousSpinner: 3,
      }),
    );
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerSeconds).toBe(12);
  });

  it('spinner counter flat for >=10s between ticks → stalled', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating… (12s · esc to interrupt)'], {
        previousSpinnerSeconds: 12,
        secondsSincePreviousSpinner: 11,
      }),
    );
    expect(result.class).toBe('thinking-stalled');
  });

  it('spinner counter flat for <10s → still active (brief pause is normal)', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating… (12s · esc to interrupt)'], {
        previousSpinnerSeconds: 12,
        secondsSincePreviousSpinner: 3,
      }),
    );
    expect(result.class).toBe('thinking-active');
  });

  // Content-based classifications (awaiting-input, shell-idle, error) were
  // removed — they fired on tool output during active turns. We now default
  // to 'unknown' (upstream maps to 'ok') whenever no spinner is visible.
  it('y/n prompt without spinner → unknown (no false banner)', () => {
    expect(
      classifyBuffer(ctx(['Do you want to continue? (y/n)'])).class,
    ).toBe('unknown');
  });

  it('shell-prompt-looking line without spinner → unknown', () => {
    expect(classifyBuffer(ctx(['user@host ~ $ '])).class).toBe('unknown');
    expect(classifyBuffer(ctx(['~/project $'])).class).toBe('unknown');
  });

  it('error-looking line without spinner → unknown (tool output often shows these)', () => {
    expect(
      classifyBuffer(ctx(['something', 'Error: ENOENT: file not found', ''])).class,
    ).toBe('unknown');
    expect(
      classifyBuffer(ctx(['Traceback: at main.py:42'])).class,
    ).toBe('unknown');
  });

  it('plain noise → unknown', () => {
    expect(
      classifyBuffer(ctx(['hello world', 'some random output'])).class,
    ).toBe('unknown');
  });

  it('sequential spinner advances — multiple ticks remain active', () => {
    let prev: number | null = null;
    const readings = [5, 8, 12, 15];
    for (const sec of readings) {
      const result = classifyBuffer(
        ctx([`⏺ Pondering… (${sec}s · esc to interrupt)`], {
          previousSpinnerSeconds: prev,
          secondsSincePreviousSpinner: 1,
        }),
      );
      expect(result.class).toBe('thinking-active');
      prev = result.spinnerSeconds;
    }
  });
});
