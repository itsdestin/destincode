import React from 'react';
import { NoteIcon } from './Icons';
import { FilepathToken } from './FilepathToken';

/**
 * A user-invoked skill (/skill-name) in the timeline.
 *
 * WHY this exists rather than a user bubble: /skill-name loads a skill's
 * instructions into the conversation, and those run to tens of thousands of
 * characters — theme-builder's SKILL.md is ~26,000. Sending them through the
 * normal user-message path rendered the entire file as one chat bubble
 * (Destin, 2026-07-28). The timeline should show what the user DID.
 *
 * Visually this deliberately matches the compact Skill card the assistant side
 * already uses (ToolCard's `isCompactSkill` branch): dashed border, note glyph,
 * "Invoked skill: <name>". Same concept, same look, whichever side ran it.
 *
 * The skill's own SKILL.md is reachable through the standard FilepathToken, so
 * it opens in the artifact viewer like any other file reference — the
 * instructions stay one click away instead of flooding the conversation.
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
    <div className="flex justify-end px-4 py-1.5">
      <div className="max-w-[80%] rounded-md border border-dashed border-edge-dim/60 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <NoteIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
          <span className="text-fg-faint text-xs select-none">|</span>
          <span className="text-xs font-medium text-fg-2">Invoked skill: {bare}</span>
        </div>
        {args && (
          <div className="mt-0.5 text-2xs text-fg-muted break-words">↳ {args}</div>
        )}
        {skillPath && (
          <div className="mt-0.5 text-2xs text-fg-muted">
            <FilepathToken path={skillPath} sessionId={sessionId} />
          </div>
        )}
        {/* displayName is carried for accessibility/tooltips; the visible label
            uses the bare command name because that is what the user typed. */}
        <span className="sr-only">{displayName}</span>
      </div>
    </div>
  );
}
