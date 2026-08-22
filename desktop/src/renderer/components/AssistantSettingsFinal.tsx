// Assistant settings — COMBINED FINAL VARIANT.
//
// What this is: the consolidation of Defaults + Permissions + Model Providers
// into ONE settings row that opens a larger tabbed settings popup, styled
// exactly like the app's other settings popups.
//
// Why this structure (synthesized from two reviews + fact-check, 2026-08-17):
//  · The tabs ARE the providers (V3's insight): Claude Code · OpenRouter ·
//    Local · Global. When the available options genuinely differ between
//    providers, the honest map is one page per provider — no engine picker
//    stacked above the tabs (that was V1's "navigation inside navigation").
//  · Permission modes reflect the REAL two unions: Claude Code sessions use
//    the CC modes (NORMAL / ACCEPT CHANGES / PLAN MODE / AUTO MODE /
//    BYPASS PERMISSIONS); OpenRouter and Local sessions are native sessions
//    with ASK FIRST / AUTO EDIT / FULL AUTO. Auto and Bypass are CC-only and
//    gated. (Fact-check: StatusBar PERMISSION_DISPLAY + shared/permission-
//    types.ts NativePermissionMode — the unions share no string values.)
//  · Mode cards are REFERENCE, not live selectors: the real app's mode is
//    owned by the active session and changed from the status-bar chip. The
//    cards explain what exists and when it appears.
//  · Always-allow grants group by project folder (the real PermissionsSection
//    pattern) and describe each rule in plain words via describeRule.
//  · No invented settings: "Friendly mode" is dropped (it is not real); the
//    Codex row is honestly labeled "idea, not committed"; package tiers use
//    the real names; "provider" not "engine".
//
// Mockup-only — workbench ?mode=workbench&view=assistant-final.
import React, { useState } from 'react';
import { Button, Dialog, SegmentedTabs, SettingRow, Toggle } from './ui';
import {
  PROVIDERS, PROVIDER_META, PROVIDER_MODELS, PROVIDER_OPTIONS,
  DEFAULT_MODEL, CC_MODES, NATIVE_MODES,
  type ProviderId,
  AssistantSettingsRow, MockDrawer, Card, Eyebrow, Chip, ModeCard,
  KeyModal, AccountModal, InfoTip,
} from './AssistantSettingsShared';

type PageId = ProviderId | 'global';

const PAGES: { id: PageId; label: string }[] = [
  ...PROVIDER_OPTIONS.map((p) => ({ id: p.id as PageId, label: p.label })),
  { id: 'global', label: 'Global' },
];

// Per-provider selections kept in records so switching providers never loses
// the choice you made for another one (V1's flaw was one shared state).
type PerProvider<T> = Record<ProviderId, T>;
const perProvider = <T,>(v: T): PerProvider<T> => ({ claude: v, openrouter: v, local: v });

function ProviderPage({ provider, model, onModelChange, perGrants, onRevoke, claudeSignedIn, onToggleClaudeSignIn, openrouterKeyed, onToggleKeyModal, accountOpen, onOpenAccount }: {
  provider: ProviderId;
  model: string;
  onModelChange: (id: string) => void;
  perGrants: Record<string, { id: string; label: string; path: string; count: number }>;
  onRevoke: (id: string) => void;
  claudeSignedIn: boolean;
  onToggleClaudeSignIn: () => void;
  openrouterKeyed: boolean;
  onToggleKeyModal: () => void;
  accountOpen: boolean;
  onOpenAccount: () => void;
}) {
  const meta = PROVIDER_META[provider];
  const modes = provider === 'claude' ? CC_MODES : NATIVE_MODES;
  // Grants shown for this provider — in the mock all providers share the same
  // project folders (grants are per-project, not per-provider; the fiction is
  // that these are the ones this provider uses).
  const grants = Object.values(perGrants);

  return (
    <div className="space-y-4">
      {/* 1 — sign-in / key — provider-specific */}
      {provider === 'claude' && (
        <section>
          <Eyebrow>Your sign-in</Eyebrow>
          <Card>
            <div>
              <SettingRow
                variant="item"
                title={<>Claude Code {claudeSignedIn ? <Chip tone="ok">Signed in</Chip> : <Chip tone="warn">Not signed in</Chip>}</>}
                description={claudeSignedIn ? 'Connected with your Claude plan' : 'Sign in with your Claude plan or an API key'}
                control={
                  <div className="flex items-center gap-1.5 shrink-0">
                    {claudeSignedIn && <Button variant="secondary" size="sm" onClick={onOpenAccount}>Account</Button>}
                    <Button variant="ghost" size="sm" onClick={onToggleClaudeSignIn}>{claudeSignedIn ? 'Sign out' : 'Sign in'}</Button>
                  </div>
                }
              />
            </div>
          </Card>
        </section>
      )}
      {provider === 'openrouter' && (
        <section>
          <Eyebrow>Your API key</Eyebrow>
          <Card>
            <div>
              <SettingRow
                variant="item"
                title={<>OpenRouter {openrouterKeyed ? <Chip tone="ok">Connected</Chip> : <Chip tone="warn">Not connected</Chip>}</>}
                description="One key for hundreds of models — GPT, Gemini, Llama and more"
                control={
                  <div className="flex items-center gap-1.5 shrink-0">
                    {openrouterKeyed && <Button variant="secondary" size="sm">Test</Button>}
                    <Button size="sm" onClick={onToggleKeyModal}>{openrouterKeyed ? 'Replace key' : 'Connect to OpenRouter'}</Button>
                  </div>
                }
              />
            </div>
          </Card>
        </section>
      )}
      {provider === 'local' && (
        <section>
          <Eyebrow>Runs on this computer</Eyebrow>
          <Card>
            <div className="text-3xs text-fg-muted px-1 py-0.5">
              Local models run entirely on this device — no internet, no account, no per-use cost. YouCoded downloads the model file and runs it with a bundled engine.
            </div>
          </Card>
        </section>
      )}

      {/* 2 — model — this provider's catalog */}
      <section>
        <Eyebrow>Model</Eyebrow>
        <Card>
          <div>
            <SettingRow
              variant="item"
              title="Default model"
              description={`Sessions on ${meta.label} start here`}
              control={
                <SegmentedTabs
                  variant="contained"
                  aria-label={`Default model for ${meta.label}`}
                  value={model}
                  onChange={onModelChange}
                  tabs={PROVIDER_MODELS[provider].map((m) => ({ id: m.id, label: m.label }))}
                />
              }
            />
          </div>
        </Card>
      </section>

      {/* 3 — permission modes — THIS provider's real union */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Permission modes</h3>
          <InfoTip label={`How approvals work on ${meta.label}`}>
            {provider === 'claude'
              ? <>Claude Code sessions: you review most actions. Auto runs on its own (only on the Opus 1M model); Bypass runs everything with no approval (only for sessions started with Skip Permissions).</>
              : <>OpenRouter and local sessions run on the native engine, which has its own three modes: ask first, accept edits automatically, or full auto with built-in safety checks.</>}
          </InfoTip>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {modes.map((m) => (
            <ModeCard key={m.id} mode={m} active={false} onSelect={() => {}} />
          ))}
        </div>
        <p className="text-3xs text-fg-faint px-1 -mt-2 mb-4">
          Reference only — the current session's mode is shown in the bar at the bottom of the chat; tap it to change.
        </p>
      </section>

      {/* 4 — always allow — grouped by project folder (real pattern) */}
      <section>
        <Eyebrow>Always allow</Eyebrow>
        <div className="space-y-2">
          {grants.length === 0 ? (
            <div className="text-3xs text-fg-muted px-1 py-1">Nothing approved yet — you'll be asked before each new action.</div>
          ) : (
            grants.map((g) => (
              <div key={g.id} className="rounded-lg border border-edge bg-well overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-edge-dim">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-fg truncate">{g.label}</div>
                    <p className="text-3xs -mt-0.5 text-fg-muted truncate">{g.path}</p>
                  </div>
                  <span className="text-3xs text-fg-muted shrink-0">{g.count} ▸</span>
                </div>
                <div className="px-2 py-2">
                  <SettingRow
                    variant="item"
                    title={g.label === 'youcoded' ? 'Push to master' : 'Remove build folder'}
                    description={`${g.label === 'youcoded' ? 'Bash · git push origin master' : 'Bash · rm -rf build'} · ${g.path}`}
                    control={<Button variant="danger-outline" size="sm" onClick={() => onRevoke(g.id)}>Revoke</Button>}
                  />
                </div>
              </div>
            ))
          )}
        </div>
        <p className="text-3xs text-fg-faint px-1 mt-2">
          Things you told your assistant it never has to ask about, grouped by project.
        </p>
      </section>
    </div>
  );
}

function GlobalPage() {
  const [folder, setFolder] = useState('/home/destin/youcoded-dev/youcoded');
  const [askClose, setAskClose] = useState(true);
  const [protections, setProtections] = useState({ config: true, dirs: true, cd: true });

  return (
    <div className="space-y-4">
      <section>
        <Eyebrow>New-session defaults</Eyebrow>
        <Card>
          <div>
            <SettingRow
              variant="item"
              title="Project folder"
              description={folder}
              control={<Button variant="secondary" size="sm" onClick={() => setFolder(folder === '/home/destin/youcoded-dev/youcoded' ? '/home/destin/Projects/study-notes' : '/home/destin/youcoded-dev/youcoded')}>Change</Button>}
            />
          </div>
          <div>
            <SettingRow
              variant="item"
              title="Ask before closing a session"
              description="Show tag options when closing a session"
              control={<Toggle checked={askClose} onChange={setAskClose} aria-label="Ask before closing a session" />}
            />
          </div>
        </Card>
      </section>

      <section>
        <Eyebrow>Protections</Eyebrow>
        <Card>
          <div>
            <SettingRow variant="item" title="Protected config files" description="Your shell settings and tool config (.bashrc, .gitconfig, and similar)" control={<Toggle checked={protections.config} onChange={(v) => setProtections((p) => ({ ...p, config: v }))} aria-label="Protected config files" />} />
          </div>
          <div>
            <SettingRow variant="item" title="Protected directories" description=".git/ and .claude/ paths" control={<Toggle checked={protections.dirs} onChange={(v) => setProtections((p) => ({ ...p, dirs: v }))} aria-label="Protected directories" />} />
          </div>
          <div>
            <SettingRow variant="item" title="Block risky chained commands" description="cd + redirect and cd + git compounds" control={<Toggle checked={protections.cd} onChange={(v) => setProtections((p) => ({ ...p, cd: v }))} aria-label="Block risky chained commands" />} />
          </div>
        </Card>
      </section>

      <section>
        <Eyebrow>Tools your assistant can use</Eyebrow>
        <Card>
          <div>
            <SettingRow
              variant="item"
              title="Package tier"
              description="Software bundled into your environment"
              control={
                <SegmentedTabs
                  variant="contained"
                  aria-label="Package tier"
                  value="dev"
                  onChange={() => {}}
                  tabs={[{ id: 'core', label: 'Core' }, { id: 'dev', label: 'Developer Essentials' }, { id: 'full', label: 'Full Dev Environment' }]}
                />
              }
            />
          </div>
          <div>
            <SettingRow
              variant="item"
              title="Specialist sub-agents"
              description="Claude can spawn specialists (researchers, editors) to work in parallel"
              control={<SegmentedTabs variant="contained" aria-label="Specialist sub-agents" value="on" onChange={() => {}} tabs={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]} />}
            />
          </div>
        </Card>
      </section>

      <div className="border border-destructive/30 rounded-lg px-3 py-2.5 mb-4">
        <SettingRow
          variant="item"
          title="Reset assistant settings"
          description="Clears your saved choices — you'll be asked again next time"
          control={<Button variant="danger" size="sm">Reset</Button>}
        />
      </div>
    </div>
  );
}

function FinalBody() {
  const [page, setPage] = useState<PageId>('claude');
  // Per-provider model + grants state.
  const [models, setModels] = useState<PerProvider<string>>({
    claude: DEFAULT_MODEL.claude,
    openrouter: DEFAULT_MODEL.openrouter,
    local: DEFAULT_MODEL.local,
  });
  const [grants, setGrants] = useState<Record<string, { id: string; label: string; path: string; count: number }>>({
    g1: { id: 'g1', label: 'youcoded', path: '/home/destin/youcoded-dev/youcoded', count: 2 },
    g2: { id: 'g2', label: 'notes', path: '/home/destin/notes', count: 1 },
  });
  const [claudeSignedIn, setClaudeSignedIn] = useState(true);
  const [openrouterKeyed, setOpenrouterKeyed] = useState(true);
  const [keyModal, setKeyModal] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-canvas">
      {/* Header: plain-language intro. No search (4 tabs, ~15 rows — a search
          box would be noise; the reviewer flagged it as such). */}
      <div className="shrink-0 px-4 pt-3 pb-0 border-b border-edge">
        <p className="text-2xs text-fg-muted max-w-xl pb-2.5">
          Choose how your assistant connects, then set what that provider may do on its own. Global holds what is the same across every provider.
        </p>
        <SegmentedTabs
          variant="bare"
          aria-label="Provider"
          value={page}
          onChange={(id) => setPage(id as PageId)}
          tabs={PAGES.map((p) => ({ id: p.id, label: p.label }))}
        />
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto px-4 py-3">
        {page !== 'global' ? (
          <ProviderPage
            key={page}
            provider={page}
            model={models[page]}
            onModelChange={(id) => setModels((m) => ({ ...m, [page]: id }))}
            perGrants={grants}
            onRevoke={(id) => setGrants((gs) => { const n = { ...gs }; delete n[id]; return n; })}
            claudeSignedIn={claudeSignedIn}
            onToggleClaudeSignIn={() => setClaudeSignedIn((v) => !v)}
            openrouterKeyed={openrouterKeyed}
            onToggleKeyModal={() => setKeyModal(true)}
            accountOpen={accountOpen}
            onOpenAccount={() => setAccountOpen(true)}
          />
        ) : (
          <GlobalPage />
        )}
      </div>

      {keyModal && (
        <KeyModal title="Connect OpenRouter" providerName="OpenRouter" onCancel={() => setKeyModal(false)} onSaved={() => { setOpenrouterKeyed(true); setKeyModal(false); }} />
      )}
      {accountOpen && <AccountModal signedIn={claudeSignedIn} onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

export function FinalEntry() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MockDrawer
        row={<AssistantSettingsRow summary="Claude Code · Sonnet" onOpen={() => setOpen(true)} />}
        caption="Combined final — provider tabs (Claude Code / OpenRouter / Local / Global), real permission unions, folder-grouped always-allow."
      />
      {open && (
        <Dialog open onClose={() => setOpen(false)} size="app" fill scrollBody={false} title="Assistant settings">
          <FinalBody />
        </Dialog>
      )}
    </>
  );
}

export default FinalEntry;
