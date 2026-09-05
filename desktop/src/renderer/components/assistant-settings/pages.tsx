import React, { useCallback, useState } from 'react';
import { CLOSE_PROMPT_SUPPRESS_KEY } from '../CloseSessionPrompt';
import ModelPicker, { type ModelChoice } from '../model/ModelPicker';
import PermissionsSection from '../PermissionsSection';
import SpecialistsSection, { SPECIALISTS_EXPLAINER_INTRO, SPECIALISTS_EXPLAINER_SECTIONS } from '../SpecialistsSection';
import { PERMISSIONS_EXPLAINER_INTRO, PERMISSIONS_EXPLAINER_SECTIONS } from '../permissions/permissions-explainer';
import type { ExplainerSection } from '../SettingsExplainer';
import {
  ClaudeCodeBlock, ChatGptBlock, OpenRouterBlock, LocalModelsBlock, SearchProvidersBlock,
  LOCAL_MODELS_INFO, WEB_SEARCH_INFO,
} from '../ModelProvidersPopup';
import SkipPermissionsSection, { type PermissionOverrides } from './SkipPermissionsSection';
import { Button, SettingRow, Toggle } from '../ui';

// The pages of Assistant settings (questions deck 2026-09-05, Q-1a: a list of
// pages down the left of one wide window). Each page is the body of one of the
// four popups the panel replaces — Session Defaults, Model Providers,
// Permissions, Specialists — re-homed, not redrawn: the blocks are the ones the
// popups rendered, so nothing changes appearance by moving here.

export type PageId = 'general' | 'claude' | 'chatgpt' | 'openrouter' | 'local' | 'permissions' | 'specialists' | 'search';

export interface AssistantDefaults {
  skipPermissions: boolean;
  model: string;
  projectFolder: string;
  permissionOverrides?: PermissionOverrides;
  /** Q-3a: one default across every provider. Absent on installs that only
   *  ever set the Claude alias (`model`), which stays the fallback. */
  startModel?: ModelChoice;
}
export type DefaultsUpdate = Partial<AssistantDefaults>;

export interface PageContext {
  defaults: AssistantDefaults;
  onDefaultsChange: (updates: DefaultsUpdate) => void;
  cwd?: string;
  onOpenClaudePreferences?: () => void;
  /** Closes the whole panel — the Claude Code Preferences button hands off to
   *  another dialog and must not leave this one open underneath it. */
  onClosePanel: () => void;
  /** Switch to another page — for the one cross-reference a page makes
   *  (Permissions → Claude Code). UX review 1, U17: "make its page a link". */
  goTo: (id: PageId) => void;
}

export interface PageDef {
  id: PageId;
  label: string;
  /** Rail group eyebrow; `null` for the ungrouped first page. */
  group: 'Providers' | 'Assistant' | null;
  icon: React.ReactNode;
  /** A short (i) beside the page title — the AnchorTip the popup section carried. */
  info?: { label: string; body: React.ReactNode };
  /** A full-page explainer (Permissions, Specialists): the (i) flips the page
   *  to it, with the dialog's back arrow to return. */
  explainer?: { intro: string; sections: ExplainerSection[] };
  /** Provider pages exist only where the native runtime does — the same gate
   *  the Model Providers row had (false over remote access, false on Android). */
  needsNative?: boolean;
  render: (ctx: PageContext) => React.ReactNode;
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" {...stroke} aria-hidden>{children}</svg>
);

// ── General ──────────────────────────────────────────────────────────────────

const CLAUDE_LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', 'opus[1m]': 'Opus', fable: 'Fable' };

/** The choice a new conversation starts on. `startModel` when set (any
 *  provider); else the Claude alias every install has carried since 1.0. */
export function startChoice(defaults: AssistantDefaults): ModelChoice {
  if (defaults.startModel) return defaults.startModel;
  // `model` is an alias ('sonnet') on every real install; a full id
  // ('claude-sonnet-4-6', the workbench fixture) is folded to its alias so the
  // picker can show the row it means instead of the raw id.
  const m = defaults.model || 'sonnet';
  const alias = m in CLAUDE_LABELS ? m : (Object.keys(CLAUDE_LABELS).find((a) => m.includes(a.replace('[1m]', ''))) ?? 'sonnet');
  return { runtime: 'claude', alias };
}

/** One short line for the Settings row: "Claude Code · Sonnet", "ChatGPT · GPT-5.6".
 *  A native choice shows its model id until the catalog label is known — the
 *  row cannot afford a lookup on every drawer open. */
export function startSummary(defaults: AssistantDefaults, labels?: Map<string, { provider: string; model: string }>): string {
  const c = startChoice(defaults);
  if (c.runtime === 'claude') return `Claude Code · ${CLAUDE_LABELS[c.alias] ?? 'Sonnet'}`;
  const known = labels?.get(`${c.providerId}/${c.modelId}`);
  return known ? `${known.provider} · ${known.model}` : c.modelId;
}

function GeneralPage({ defaults, onDefaultsChange }: PageContext) {
  // Close-session prompt suppression — reads/writes localStorage directly since
  // this is a UI preference, not a session default backed by sessionDefaults.
  const [closePromptDisabled, setClosePromptDisabled] = useState(
    () => localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1',
  );
  const handleBrowseFolder = useCallback(async () => {
    try {
      const folder = await (window as any).claude.dialog.openFolder();
      if (folder) onDefaultsChange({ projectFolder: folder });
    } catch {}
  }, [onDefaultsChange]);

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">New conversations</h3>
        {/* Q-3a: the same picker the chat uses, so any connected model can be
            the default — the four Claude tabs are gone. Stacked like the
            Specialists tier rows: label + hint, then the picker at full width. */}
        <div className="bg-inset/50 rounded-lg px-3 py-2.5 space-y-1.5">
          <div>
            <p className="text-xs font-medium text-fg">Start on</p>
            <p className="text-3xs text-fg-muted">The model a new conversation uses until you pick another.</p>
          </div>
          <ModelPicker
            value={startChoice(defaults)}
            onSelect={(choice) => onDefaultsChange({
              startModel: choice,
              // Keep the legacy alias in step for a Claude pick, so everything
              // that still reads `model` (session create, the status bar) agrees.
              ...(choice.runtime === 'claude' ? { model: choice.alias } : {}),
            })}
          />
        </div>
      </section>

      <div className="space-y-2">
        <SettingRow
          variant="item"
          title="Project folder"
          description={defaults.projectFolder || 'Home directory (default)'}
          control={
            <div className="flex items-center gap-1 shrink-0">
              {defaults.projectFolder && (
                <Button variant="ghost" size="sm" onClick={() => onDefaultsChange({ projectFolder: '' })}>
                  Reset
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => void handleBrowseFolder()}>
                Change
              </Button>
            </div>
          }
        />
        <SettingRow
          variant="item"
          title="Close-session prompt"
          description="Show tag options when closing a session"
          control={
            <Toggle
              checked={!closePromptDisabled}
              onChange={(show) => {
                const next = !show;
                setClosePromptDisabled(next);
                if (next) localStorage.setItem(CLOSE_PROMPT_SUPPRESS_KEY, '1');
                else localStorage.removeItem(CLOSE_PROMPT_SUPPRESS_KEY);
              }}
              aria-label="Close-session prompt"
            />
          }
        />
      </div>
    </div>
  );
}

// ── The registry ─────────────────────────────────────────────────────────────

export const PAGES: PageDef[] = [
  {
    id: 'general',
    label: 'General',
    group: null,
    icon: <Icon><line x1="4" y1="7" x2="20" y2="7" /><circle cx="8" cy="7" r="2.2" fill="var(--panel)" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="16" cy="17" r="2.2" fill="var(--panel)" /></Icon>,
    render: (ctx) => <GeneralPage {...ctx} />,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    group: 'Providers',
    needsNative: true,
    icon: <Icon><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></Icon>,
    render: (ctx) => (
      <div className="space-y-5">
        <ClaudeCodeBlock onOpenClaudePreferences={ctx.onOpenClaudePreferences} onCloseParent={ctx.onClosePanel} />
        {/* Q-2 note: Claude Code's permissions are one switch and its advanced
            list, so they live here rather than on the Permissions page, which
            covers the other providers' modes and Always-allow list. */}
        <SkipPermissionsSection defaults={ctx.defaults} onDefaultsChange={ctx.onDefaultsChange} />
      </div>
    ),
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    group: 'Providers',
    needsNative: true,
    icon: <Icon><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" /><path d="M8 12h8M12 8v8" /></Icon>,
    render: () => <ChatGptBlock />,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'Providers',
    needsNative: true,
    icon: <Icon><path d="M4 12h5l3-6 3 12 3-6h2" /></Icon>,
    // The block renders the OpenRouter card and, under it, the list of your own
    // API keys and custom endpoints; on its own page that list needs the
    // eyebrow the popup's OpenRouter (i) used to imply ("…or a custom endpoint
    // below"), or an empty list is one orphaned Add provider button.
    render: () => <OpenRouterBlock keysHeading="Your own API keys" />,
  },
  {
    id: 'local',
    label: 'Local models',
    group: 'Providers',
    needsNative: true,
    info: LOCAL_MODELS_INFO,
    icon: <Icon><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>,
    render: () => <LocalModelsBlock withHeader={false} />,
  },
  {
    id: 'permissions',
    label: 'Permissions',
    group: 'Assistant',
    explainer: { intro: PERMISSIONS_EXPLAINER_INTRO, sections: PERMISSIONS_EXPLAINER_SECTIONS },
    icon: <Icon><path d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6l7-3z" /><path d="M9 12l2 2 4-4" /></Icon>,
    render: (ctx) => (
      <div className="space-y-3">
        {/* The one sentence the split needs (Q-2): this page is the native
            modes and grants; Claude Code's switch is on its own page. UX
            review 1 (U7, U17): say that Claude Code's approvals are not in
            this list either, and make the page name a link. */}
        <p className="text-2xs text-fg-dim leading-relaxed">
          Applies to ChatGPT, OpenRouter and local models. Claude Code asks in its own way, and its
          switch is on the{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => ctx.goTo('claude')}>
            Claude Code page
          </button>.
        </p>
        <PermissionsSection />
      </div>
    ),
  },
  {
    id: 'specialists',
    label: 'Specialists',
    group: 'Assistant',
    explainer: { intro: SPECIALISTS_EXPLAINER_INTRO, sections: SPECIALISTS_EXPLAINER_SECTIONS },
    icon: <Icon><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 5.5a3 3 0 0 1 0 5.6" /><path d="M17.5 14.5c2 .6 3.5 2.4 3.5 4.5" /></Icon>,
    render: (ctx) => <SpecialistsSection cwd={ctx.cwd} />,
  },
  {
    id: 'search',
    label: 'Web search',
    group: 'Assistant',
    needsNative: true,
    info: WEB_SEARCH_INFO,
    icon: <Icon><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></Icon>,
    render: () => <SearchProvidersBlock withHeader={false} />,
  },
];
