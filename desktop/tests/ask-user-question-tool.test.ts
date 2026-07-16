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
});
