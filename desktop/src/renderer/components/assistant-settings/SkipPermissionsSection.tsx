import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Callout, Dialog, SettingRow, Toggle } from '../ui';

// Claude Code's permission settings: the Skip Permissions switch and, behind
// it, the protection overrides. Moved out of SettingsPanel.tsx's Session
// Defaults popup and onto the Claude Code page of Assistant settings
// (questions deck 2026-09-05, Q-2 note: "if it's JUST skip permissions, that
// should just go on the claude code page" — it is one switch plus its
// advanced list, and none of it applies to ChatGPT, OpenRouter or local
// conversations, which run on the three native modes instead).
//
// Everything below is the shipped Session Defaults code, unchanged in copy and
// behaviour; the only edit is that it takes the shared `Toggle` directly
// instead of SettingsPanel's compat wrapper (importing that back from
// SettingsPanel would be a circular import).

export interface PermissionOverrides {
  approveAll: boolean;
  protectedConfigFiles: boolean;
  protectedDirectories: boolean;
  compoundCdRedirect: boolean;
  compoundCdGit: boolean;
}

const OVERRIDES_DEFAULT: PermissionOverrides = {
  approveAll: false,
  protectedConfigFiles: false,
  protectedDirectories: false,
  compoundCdRedirect: false,
  compoundCdGit: false,
};

// Per-category override toggles for the Advanced section
const OVERRIDE_CATEGORIES: { key: keyof Omit<PermissionOverrides, 'approveAll'>; label: string; description: string }[] = [
  { key: 'protectedConfigFiles', label: 'Config files', description: '.bashrc, .gitconfig, .mcp.json' },
  { key: 'protectedDirectories', label: 'Protected directories', description: '.git/, .claude/ paths' },
  { key: 'compoundCdRedirect', label: 'cd + redirect commands', description: 'Compound cd with output redirection' },
  { key: 'compoundCdGit', label: 'cd + git commands', description: 'Compound cd with git operations' },
];

export default function SkipPermissionsSection({ defaults, onDefaultsChange }: {
  defaults: { skipPermissions: boolean; permissionOverrides?: PermissionOverrides };
  onDefaultsChange: (updates: { skipPermissions?: boolean; permissionOverrides?: PermissionOverrides }) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const overrides = { ...OVERRIDES_DEFAULT, ...defaults.permissionOverrides };

  const updateOverride = useCallback((key: keyof PermissionOverrides, value: boolean) => {
    onDefaultsChange({ permissionOverrides: { ...overrides, [key]: value } });
  }, [overrides, onDefaultsChange]);

  const handleApproveAllToggle = useCallback(() => {
    if (!overrides.approveAll) {
      // Turning ON — show confirmation popup
      setConfirmOpen(true);
    } else {
      // Turning OFF — immediate
      updateOverride('approveAll', false);
    }
  }, [overrides.approveAll, updateOverride]);

  return (
    <section>
      {/* K9 — danger zone. One shape: a "Danger zone" K1 label, the consequence
          in a K4 danger callout, and the control, callout and control kept
          together. The callout sits AFTER the control (approved 2026-07-28):
          for a toggle the sentence is a consequence of the state you just
          turned on, and it only exists while the toggle is on. */}
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Danger zone</h3>
      <SettingRow
        variant="item"
        title="Skip Permissions"
        description="New Claude Code conversations will skip tool approval"
        control={
          <Toggle
            checked={defaults.skipPermissions}
            onChange={() => onDefaultsChange({ skipPermissions: !defaults.skipPermissions })}
            tone="danger"
            aria-label="Skip Permissions"
          />
        }
      />
      {defaults.skipPermissions && (
        <Callout tone="danger" className="mt-2">
          Claude will execute tools without asking for approval.
        </Callout>
      )}
      {defaults.skipPermissions && (
        <>
          {/* Advanced — an expand-in-place section is a SettingRow with
              `expanded` (G-22, 2026-09-05: "I HATE the bare dropdowns with a
              chevron"). The shipped popup still had the bare text toggle; the
              move is the moment to take the row shape. */}
          <div className="mt-2">
            <SettingRow
              variant="item"
              title="Advanced"
              description="Approve protected requests by category"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              expanded={advancedOpen}
            />
          </div>

          {advancedOpen && (
            <div className="mt-2 ml-1 border-l border-edge-dim pl-3 space-y-3">
              <SettingRow
                variant="item"
                title="Auto-approve all"
                description="Silently approve all protected requests"
                control={<Toggle checked={overrides.approveAll} onChange={handleApproveAllToggle} tone="danger" aria-label="Auto-approve all" />}
              />

              {/* Separator */}
              <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-edge-dim" />
                <span className="text-4xs text-fg-muted">or approve by category</span>
                <div className="flex-1 border-t border-edge-dim" />
              </div>

              {/* Per-category toggles */}
              {OVERRIDE_CATEGORIES.map(({ key, label, description }) => (
                <SettingRow
                  key={key}
                  variant="item"
                  title={label}
                  description={description}
                  // 40% + pointer-events-none, not the row's own `disabled`: this
                  // is "superseded by approve-all", not "unavailable", and the
                  // existing resting opacity is what the spec approved.
                  className={overrides.approveAll ? 'opacity-40 pointer-events-none' : ''}
                  control={<Toggle checked={overrides[key]} onChange={() => updateOverride(key, !overrides[key])} aria-label={`Auto-approve ${label}`} />}
                />
              ))}
            </div>
          )}

          {/* Confirmation popup for Approve All — L3 destructive, theme-driven glass */}
          {confirmOpen && createPortal(
            <>
              <Dialog
                open
                onClose={() => setConfirmOpen(false)}
                layer={3}
                destructive
                size="prompt"
                title="This is extremely dangerous"
                scrollBody={false}
              >
                <div className="px-4 py-3 space-y-2">
                  <Callout tone="danger">
                    <strong>This setting is not recommended or condoned by Claude, Anthropic, or YouCoded.</strong>{' '}
                    Do not enable this unless you fully understand the consequences.
                  </Callout>
                  <p className="text-3xs text-fg-dim leading-relaxed">
                    Full auto-approve silently grants <strong>every</strong> remaining permission request with zero human review. Claude will be able to:
                  </p>
                  <ul className="text-3xs text-fg-muted space-y-1 ml-3 list-disc">
                    <li>Overwrite your <code className="text-fg-dim">.git/</code> history and repository internals</li>
                    <li>Modify shell config files (<code className="text-fg-dim">.bashrc</code>, <code className="text-fg-dim">.gitconfig</code>, <code className="text-fg-dim">.zshrc</code>)</li>
                    <li>Rewrite <code className="text-fg-dim">.claude/</code> configuration and MCP settings</li>
                    <li>Execute compound commands that bypass path resolution safety checks</li>
                    <li>Execute compound commands that bypass bare repository attack protections</li>
                  </ul>
                  <p className="text-3xs text-destructive-fg/80 leading-relaxed font-medium">
                    These protections exist for a reason. Disabling them means a single bad model output could corrupt your repository, hijack your shell environment, or escalate access beyond this project. There is no undo.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <Button variant="secondary" onClick={() => setConfirmOpen(false)} className="flex-1">
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => { updateOverride('approveAll', true); setConfirmOpen(false); }}
                      className="flex-1"
                    >
                      I understand, enable anyway
                    </Button>
                  </div>
                </div>
              </Dialog>
            </>,
            document.body,
          )}
        </>
      )}
    </section>
  );
}
