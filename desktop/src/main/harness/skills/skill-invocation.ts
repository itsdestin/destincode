/**
 * How a user-invoked skill is presented TO THE MODEL.
 *
 * Framing matters as much as content. Handed the instructions alone, the model
 * treats them as a document it received and answers "Understood. I have loaded
 * the theme-builder skill. This skill guides a complex, multi-phase workflow…" —
 * a whole turn spent describing what it was about to do (Destin, 2026-07-28).
 * Naming the invocation and asking for work rather than a summary is what makes
 * /skill-name behave the way it does in Claude Code.
 *
 * Pure so the exact wording is testable; the wording is the entire mechanism.
 */
export function frameSkillInvocation(skillId: string, instructions: string, args?: string): string {
  // The bare command name is what the user typed — "/theme-builder", not
  // "/wecoded-themes-plugin:theme-builder" — so that is what we echo back.
  const bare = skillId.includes(':') ? skillId.split(':').slice(-1)[0] : skillId;
  const parts = [
    `<skill-instructions name="${skillId}">\n${instructions}\n</skill-instructions>`,
    `The user ran /${bare}. Begin following these instructions now — do not summarize them back.`,
  ];
  // The user's own words go LAST so they are the most recent thing the model
  // reads: a skill that says "act on what the user asked" needs them in view.
  if (args) parts.push(args);
  return parts.join('\n\n');
}
