import React from 'react';
import { NoteIcon } from './Icons';
import { FilepathToken } from './FilepathToken';

/**
 * A user-invoked skill (/skill-name) in the timeline.
 *
 * WHY this exists rather than a user bubble full of text: /skill-name loads a
 * skill's instructions into the conversation, and those run to tens of thousands
 * of characters — theme-builder's SKILL.md is ~26,000. Sending them through the
 * normal user-message path rendered the entire file as one chat bubble
 * (Destin, 2026-07-28). The timeline should show what the user DID.
 *
 * It IS still a bubble, though. The first attempt gave this a dashed border and
 * no background, copying the compact Skill card the assistant side uses — but
 * that card gets its surface from the assistant bubble it sits inside. Standing
 * alone on the canvas it rendered transparent, floating on the wallpaper with
 * nothing tying it to the conversation (Destin: "why was the user message bubble
 * clear?"). So: same right-aligned bubble geometry as a user message, and the
 * same `in-view` + `bg-inset` pairing ThinkingIndicator uses, which is what opts
 * a non-user-bubble chat row into wallpaper-driven glassmorphism (the theme
 * engine targets `.in-view .bg-inset` descendants).
 *
 * Quieter than a real user bubble on purpose — bg-inset rather than bg-accent —
 * because the user typed one short command, not this content.
 *
 * The skill's own SKILL.md rides along as a standard FilepathToken, so it opens
 * in the artifact viewer like any other file reference: the instructions stay one
 * click away instead of flooding the conversation.
 */
export default function SkillInvocationCard({
  skillId, displayName, args, skillPath, sessionId,
}: {
  skillId: string;
  displayName: string;
  args?: string;
  skillPath?: string;
  sessionId: string;
}) {
  // Strip the plugin namespace ("wecoded-themes-plugin:theme-builder" ->
  // "theme-builder") so the label reads as the command the user actually typed,
  // not as a technical id. Same treatment as friendlyToolDisplay's Skill case.
  const bare = skillId.includes(':') ? skillId.split(':').slice(-1)[0] : skillId;

  return (
    <div className="flex justify-end px-4 py-1.5 in-view">
      <div className="max-w-[80%] bg-inset rounded-2xl rounded-br-sm px-4 py-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <NoteIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
          <span className="text-sm text-fg-2" title={displayName}>Invoked skill: {bare}</span>
          {skillPath && <FilepathToken path={skillPath} sessionId={sessionId} />}
        </div>
        {args && (
          <div className="mt-1 text-xs text-fg-dim break-words">{args}</div>
        )}
      </div>
    </div>
  );
}
