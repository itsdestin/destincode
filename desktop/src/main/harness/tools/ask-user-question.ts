// AskUserQuestion (spec §3.3): CC's exact name + input shape so the existing
// AskUserQuestionCard renders it unchanged. INTERACTIVE — the driver routes it
// straight to askUser() (the permission-ask rail: pause, cancel-on-interrupt,
// PermissionExpired on teardown all come free); execute() never runs. NOT wrapped
// by defineTool(): it needs no truncation and the driver short-circuits it before
// execute — the plain NativeTool shape (name/description/inputSchema/
// permissionSubject + interactive) is all the driver reads.
import { z } from 'zod';
import type { NativeTool, ToolResultPayload } from './types';

const optionSchema = z.object({ label: z.string().min(1), description: z.string().optional() });
const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).max(12),
  options: z.array(optionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});
const inputSchema = z.object({ questions: z.array(questionSchema).min(1).max(4) });
export type AskUserQuestionInput = z.infer<typeof inputSchema>;

/** Turn the card's updatedInput ({questions, answers: Record<question, labels>})
 *  into the tool-result text the model reads. */
export function formatAnswers(args: AskUserQuestionInput, updatedInput: Record<string, unknown> | undefined): string {
  const answers = (updatedInput?.answers ?? {}) as Record<string, string>;
  const lines = args.questions.map((qq) => {
    const a = answers[qq.question];
    return `Q: ${qq.question}\nA: ${a && a.trim() ? a : '(no selection — the user did not answer this one)'}`;
  });
  return `The user answered:\n\n${lines.join('\n\n')}`;
}

export const AskUserQuestionTool: NativeTool<AskUserQuestionInput> = {
  name: 'AskUserQuestion',
  description:
    'Ask the user 1-4 multiple-choice questions when you genuinely need their input to proceed (preferences, ambiguous requirements, a decision only they can make). Each question needs a short header (max 12 chars) and 2-4 options. Do not use it for questions you can answer yourself.',
  inputSchema,
  interactive: true,
  permissionSubject: () => undefined,
  // Defensive only — the driver intercepts interactive tools before execute.
  async execute(): Promise<ToolResultPayload> {
    return { text: 'AskUserQuestion must be routed through the interactive ask rail; this is a configuration error.', isError: true };
  },
};
