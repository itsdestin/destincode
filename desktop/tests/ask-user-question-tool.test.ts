import { describe, it, expect } from 'vitest';
import { AskUserQuestionTool, formatAnswers } from '../src/main/harness/tools/ask-user-question';

const q = (over: Partial<any> = {}) => ({
  question: 'Which color?', header: 'Color', multiSelect: false,
  options: [{ label: 'Blue' }, { label: 'Red', description: 'bold choice' }], ...over,
});

describe('AskUserQuestion schema', () => {
  it('accepts the CC shape', () => {
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [q()] }).success).toBe(true);
  });
  it('rejects zero questions, >4 questions, <2 options', () => {
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [q(), q(), q(), q(), q()] }).success).toBe(false);
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [q({ options: [{ label: 'only' }] })] }).success).toBe(false);
  });
  it('is marked interactive with no permission subject', () => {
    expect(AskUserQuestionTool.interactive).toBe(true);
    expect(AskUserQuestionTool.permissionSubject({ questions: [q()] } as any)).toBeUndefined();
  });
});

describe('formatAnswers', () => {
  it('pairs each question with its answer', () => {
    const text = formatAnswers({ questions: [q(), q({ question: 'Size?', header: 'Size' })] } as any,
      { questions: [], answers: { 'Which color?': 'Blue', 'Size?': 'Large, Medium' } });
    expect(text).toContain('Which color?');
    expect(text).toContain('Blue');
    expect(text).toContain('Large, Medium');
  });
  it('marks unanswered questions instead of dropping them', () => {
    const text = formatAnswers({ questions: [q()] } as any, { questions: [], answers: {} });
    expect(text).toMatch(/no selection|did not answer/i);
  });
  it('is TOTAL on untrusted answer shapes (array / number) — never throws, produces a sensible pairing', () => {
    // updatedInput is UNTRUSTED (renderer AND remote WS clients). An array is the
    // natural way a client might encode a multi-select answer; a number is junk.
    // A throw here would skip the role:'tool' history push → dangling tool_call →
    // bricked session. formatAnswers MUST stay total.
    let text = '';
    expect(() => {
      text = formatAnswers(
        { questions: [q(), q({ question: 'Size?', header: 'Size' })] } as any,
        { questions: [], answers: { 'Which color?': ['Blue', 'Red'], 'Size?': 5 } },
      );
    }).not.toThrow();
    expect(text).toContain('Blue, Red');                 // array joined
    expect(text).toMatch(/Size\?/);                       // still paired
    expect(text).toMatch(/no selection|did not answer/i); // number → fallback
  });
  it('does not throw when answers itself is not an object (null / array)', () => {
    expect(() => formatAnswers({ questions: [q()] } as any, { questions: [], answers: null as any })).not.toThrow();
    expect(() => formatAnswers({ questions: [q()] } as any, { questions: [], answers: [] as any })).not.toThrow();
    expect(() => formatAnswers({ questions: [q()] } as any, undefined)).not.toThrow();
  });
});
