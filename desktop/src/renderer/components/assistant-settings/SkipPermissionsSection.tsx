import React from 'react';
import { Callout, SettingRow, Toggle } from '../ui';

// Claude Code's one permission setting: the Skip Permissions switch. It lived
// in SettingsPanel.tsx's Session Defaults popup; it is now the first block of
// Assistant settings → Permissions (review round 1, 2026-09-05, P-5 note:
// "the permissions stuff from claude can move to permissions").
//
// What is NOT here any more: the "Advanced" list of protection overrides
// (Auto-approve all, config files, protected directories, the two compound-cd
// switches) and its "This is extremely dangerous" confirmation. Destin dropped
// the whole idea on the round-1 deck (P-4 note, P-14): "we should probably
// completely drop the 'approve protected requests' idea, as it may get us in
// trouble with anthropic." The stored `permissionOverrides` still exist on
// users' machines; the build stage decides what to do with a value that was
// switched on and now has no switch (the deck's R2 step names the risk).
//
// Wording (P-13, pick b, then round 2's R2-4): Destin rewrote the row himself
// — "Enable Skip Permissions Mode?" over a hint that names the Claude Code
// flag it sets. His copy, used verbatim.

export interface PermissionOverrides {
  approveAll: boolean;
  protectedConfigFiles: boolean;
  protectedDirectories: boolean;
  compoundCdRedirect: boolean;
  compoundCdGit: boolean;
}

export default function SkipPermissionsSection({ defaults, onDefaultsChange }: {
  defaults: { skipPermissions: boolean };
  onDefaultsChange: (updates: { skipPermissions?: boolean }) => void;
}) {
  return (
    <section>
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Claude Code</h3>
      {/* Title and hint are Destin's words verbatim (round 2, R2-4). They name
          the Claude Code flag on purpose: this switch does nothing but set it. */}
      <SettingRow
        variant="item"
        title="Enable Skip Permissions Mode?"
        description="Allows you to toggle claude code's --dangerously-skip-permissions flag when creating a session. Claude won't ask before taking action"
        control={
          <Toggle
            checked={defaults.skipPermissions}
            onChange={() => onDefaultsChange({ skipPermissions: !defaults.skipPermissions })}
            tone="danger"
            aria-label="Enable Skip Permissions Mode?"
          />
        }
      />
      {/* The consequence sits AFTER the switch (approved 2026-07-28): for a
          toggle the sentence describes the state you just turned on and only
          exists while it is on. */}
      {defaults.skipPermissions && (
        <Callout tone="danger" className="mt-2">
          Claude will change files and run commands without asking you.
        </Callout>
      )}
    </section>
  );
}
