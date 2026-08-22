// Shared building blocks for the "Assistant settings" mockups.
//
// FACT-CHECKED against the real app (2026-08-17):
//  · Permission modes: Claude Code sessions use the CC union (NORMAL / ACCEPT
//    CHANGES / PLAN MODE / AUTO MODE / BYPASS PERMISSIONS — StatusBar.tsx
//    PERMISSION_DISPLAY). OpenRouter and Local sessions are NATIVE sessions
//    with a DIFFERENT union (ASK FIRST / AUTO EDIT / FULL AUTO —
//    shared/permission-types.ts NativePermissionMode). The two share no string
//    values. Auto is CC-only and gated on the Opus 1M model; Bypass is CC-only
//    and gated on sessions started with Skip Permissions.
//  · Providers: Anthropic / OpenAI / Google / Custom endpoint (OpenAI-
//    compatible) are all REAL add-options today (ProvidersSection.tsx
//    ADD_TYPE_OPTIONS). OpenRouter catalog is vendor-prefixed and live.
//  · Local models: real curated catalog (Qwen3.5 2B/4B/9B/35B/122B, Gemma 4,
//    GPT-OSS 20B/120B, Qwen3.6 27B), sizes computed live, disk guard real.
//  · Codex is a ROADMAP "deliberate what-if, not a commitment" — honest label
//    is "idea / exploring", not PLANNED.
//  · "Friendly mode" is invented for the mockup (design doc open question).
//  · Package tiers: Core / Developer Essentials / Full Dev Environment.
//  · Specialists (4 built-ins) and MCP exist; MCP has no settings UI yet.
//
// Mockup-only: nothing writes to the real app. Rendered in the workbench.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, SettingRow, TextInput, Callout, AnchorTip } from './ui';
import { MODELS } from './StatusBar';
import { describeRule } from './permissions/describe-rule';
import type { PermissionRule } from '../../shared/permission-types';

// ── Providers (the word the app uses — "engine" is jargon) ─────────────────

export type ProviderId = 'claude' | 'openrouter' | 'local';

export const PROVIDERS: ProviderId[] = ['claude', 'openrouter', 'local'];

export const PROVIDER_META: Record<ProviderId, { label: string; blurb: string }> = {
  claude: {
    label: 'Claude Code',
    blurb: "Anthropic's AI coding agent — the engine YouCoded is built around. It signs in with your Claude Pro or Max plan; there's no extra account to create.",
  },
  openrouter: {
    label: 'OpenRouter',
    blurb: 'A single gateway to hundreds of models — GPT, Gemini, Llama and more — with one API key. You pay OpenRouter directly for what you use.',
  },
  local: {
    label: 'Local models',
    blurb: 'Models that run entirely on this computer — no internet, no account, no per-use cost. YouCoded downloads the model file and runs it with a bundled engine.',
  },
};

export const PROVIDER_OPTIONS: { id: ProviderId; label: string }[] = PROVIDERS.map((id) => ({
  id,
  label: PROVIDER_META[id].label,
}));

// Models each provider can run. Claude Code uses CC aliases (incl. Fable — a
// real fifth alias); OpenRouter's catalog is vendor-prefixed and live.
export const PROVIDER_MODELS: Record<ProviderId, { id: string; label: string }[]> = {
  claude: [...MODELS].map((m) => ({
    id: m,
    label: ({ haiku: 'Haiku', sonnet: 'Sonnet', 'opus[1m]': 'Opus', fable: 'Fable' } as Record<string, string>)[m] || m,
  })),
  openrouter: [
    { id: 'openai/gpt-5', label: 'GPT-5' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  ],
  local: [
    { id: 'qwen3.5-35b-a3b', label: 'Qwen3.5 35B-A3B' },
    { id: 'gemma-4-12b', label: 'Gemma 4 12B' },
    { id: 'gpt-oss-20b', label: 'GPT-OSS 20B' },
  ],
};

export const DEFAULT_MODEL: Record<ProviderId, string> = {
  claude: 'sonnet',
  openrouter: 'openai/gpt-5',
  local: 'qwen3.5-35b-a3b',
};

// ── Permission modes — TWO REAL UNIONS, not one ─────────────────────────────

// Claude Code sessions: the CC CLI union. StatusBar PERMISSION_DISPLAY labels.
export type CcModeId = 'normal' | 'auto-accept' | 'plan' | 'auto' | 'bypass';

export const CC_MODES: { id: CcModeId; title: string; chip: string; desc: string; gate?: string }[] = [
  { id: 'normal', title: 'Standard', chip: 'NORMAL', desc: 'You review each action before it runs — the safe default.' },
  { id: 'auto-accept', title: 'Accept changes', chip: 'ACCEPT CHANGES', desc: 'File edits and quick actions go ahead; you still approve commands.' },
  { id: 'plan', title: 'Plan mode', chip: 'PLAN MODE', desc: 'Reads and plans, but makes no changes until you say go.' },
  { id: 'auto', title: 'Auto mode', chip: 'AUTO MODE', desc: 'Claude works ahead on its own, deciding what is safe.', gate: 'Only on the Opus 1M model' },
  { id: 'bypass', title: 'Bypass prompts', chip: 'BYPASS PERMISSIONS', desc: 'Tools run with no approval.', gate: 'Only for sessions started with Skip Permissions' },
];

// Native (OpenRouter / Local) sessions: NativePermissionMode union.
export type NativeModeId = 'ask' | 'auto-edit' | 'full-auto';

export const NATIVE_MODES: { id: NativeModeId; title: string; chip: string; desc: string; gate?: string }[] = [
  { id: 'ask', title: 'Ask first', chip: 'ASK FIRST', desc: 'You review each action before it runs — the safe default.' },
  { id: 'auto-edit', title: 'Accept edits', chip: 'AUTO EDIT', desc: 'File edits go ahead; you still approve commands.' },
  { id: 'full-auto', title: 'Full auto', chip: 'FULL AUTO', desc: 'Everything runs ahead with built-in safety checks.', gate: 'Deny-list guarded — safer than full bypass' },
];

// ── Small shared UI pieces ──────────────────────────────────────────────────

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  // Real cards are px-3 py-2.5 (ModelProvidersPopup, PermissionsSection).
  return <div className={`bg-inset/50 rounded-lg px-3 py-2.5 mb-4 ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  // K1 section label — the app's shared uppercase section header.
  return <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2 mt-4 first:mt-0">{children}</h3>;
}

/** Status chip — the app's real STATUS_TONE_CLASS recipe (MarketplaceCard). */
export function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'neu' | 'bad'; children: React.ReactNode }) {
  const c = {
    ok: 'bg-green-500/15 text-green-400 border border-green-500/30',
    warn: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
    bad: 'bg-red-500/15 text-red-400 border border-red-500/30',
    neu: 'bg-inset text-fg-2 border border-edge',
  }[tone];
  const d = { ok: 'bg-green-500', warn: 'bg-amber-500', bad: 'bg-red-400', neu: 'bg-fg-muted' }[tone];
  return (
    <span className={`inline-flex items-center gap-1 text-3xs font-semibold px-2 py-0.5 rounded-full ${c}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${d}`} />
      {children}
    </span>
  );
}

/** A single reference permission-mode card. Renders availability + gate; not a
 *  live selector (the real app's mode is owned by the active session and set
 *  from the status-bar chip). The gate note replaces "not available" because
 *  the mode exists — it is just gated on a session condition. */
export function ModeCard({ mode, active, onSelect }: {
  mode: { id: string; title: string; chip: string; desc: string; gate?: string };
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded-lg border p-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
        active ? 'border-accent bg-accent/10' : 'border-edge-dim hover:border-edge bg-inset/50'
      }`}
    >
      <span className="inline-flex items-center gap-1 text-3xs font-semibold px-2 py-0.5 rounded-full bg-inset text-fg-muted mb-1.5">
        {mode.chip}
      </span>
      <div className="text-xs font-semibold text-fg">{mode.title}</div>
      <div className="text-3xs text-fg-muted mt-0.5 leading-relaxed">{mode.desc}</div>
      {mode.gate && <div className="text-3xs text-fg-faint mt-1 leading-relaxed">{mode.gate}</div>}
    </button>
  );
}

/** Plain-language explanation of an always-allow rule, via the real
 *  describeRule helper (permissions/describe-rule.ts) — the app's own copy. */
export function GrantLine({ rule, project }: { rule: PermissionRule & { grantedAt?: string }; project: string }) {
  const described = describeRule(rule);
  const line = described.subject ? `${described.verb} ${described.subject}` : described.verb;
  return (
    <span>
      {line}
      {described.width === 'tool-wide' && <span className="text-fg-faint"> — every use</span>}
      <span className="text-fg-faint"> · {project}</span>
    </span>
  );
}

// ── Simulated local-model installs ──────────────────────────────────────────

export type LocalModel = { name: string; source: string; size: string; state: 'ready' | 'downloading' | 'available'; progress?: number };

export function useSimulatedModels() {
  const [models, setModels] = useState<LocalModel[]>([
    { name: 'Qwen3.5 35B-A3B', source: 'Curated', size: '~24 GB', state: 'ready' },
    { name: 'Gemma 4 12B', source: 'Curated', size: '~9 GB', state: 'ready' },
    { name: 'GPT-OSS 20B', source: 'Curated', size: '~12 GB', state: 'downloading', progress: 42 },
    { name: 'Qwen3.5 9B', source: 'Curated', size: '~6 GB', state: 'available' },
    { name: 'Gemma 4 4B', source: 'Curated', size: '~3 GB', state: 'available' },
  ]);
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  useEffect(() => () => { Object.values(timersRef.current).forEach(clearInterval); }, []);

  const startInstall = useCallback((name: string) => {
    setModels((ms) => ms.map((m) => (m.name === name ? { ...m, state: 'downloading' as const, progress: 5 } : m)));
    timersRef.current[name] = setInterval(() => {
      setModels((ms) => ms.map((m) => {
        if (m.name !== name || m.state !== 'downloading') return m;
        const next = (m.progress ?? 5) + 9;
        if (next >= 100) {
          clearInterval(timersRef.current[name]);
          return { ...m, state: 'ready' as const, progress: 100 };
        }
        return { ...m, progress: next };
      }));
    }, 300);
  }, []);

  const pauseInstall = useCallback((name: string) => {
    clearInterval(timersRef.current[name]);
  }, []);

  const removeModel = useCallback((name: string) => {
    setModels((ms) => ms.map((m) => (m.name === name ? { ...m, state: 'available' as const, progress: undefined } : m)));
  }, []);

  return { models, startInstall, pauseInstall, removeModel };
}

// ── Mock modals (same shapes the real popups use) ───────────────────────────

/** Key entry — mirrors the real ConnectOpenRouterModal (steps + key field). */
export function KeyModal({ title, onCancel, onSaved, providerName }: {
  title: string;
  onCancel: () => void;
  onSaved: () => void;
  providerName: string;
}) {
  const [draft, setDraft] = useState('');
  return (
    <Dialog open onClose={onCancel} layer={3} size="prompt" title={title} scrollBody={false}>
      <div className="p-4 space-y-3">
        <ol className="text-2xs text-fg-2 leading-relaxed space-y-1 list-decimal pl-4">
          <li>Create a free account at {providerName}.</li>
          <li>Add a little credit and create an API key.</li>
          <li>Paste the key below and press Save (mock flow).</li>
        </ol>
        <TextInput
          type="password"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) onSaved(); }}
          placeholder={`Paste your ${providerName} API key`}
          aria-label={`${providerName} API key`}
          className="w-full"
        />
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onCancel} className="flex-1 py-2">Cancel</Button>
          <Button onClick={onSaved} disabled={draft.trim().length === 0} className="flex-1 py-2">Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Sign-in/sign-out mock for the Claude Code card. */
export function AccountModal({ signedIn, onClose }: { signedIn: boolean; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} layer={3} size="prompt" title="Claude Code account" scrollBody={false}>
      <div className="p-4 space-y-3">
        <p className="text-2xs text-fg-2 leading-relaxed">
          {signedIn
            ? 'Signed in with your Claude Pro plan. No extra account to create — Claude Code signs in with the same plan you already have.'
            : 'Not signed in. Sign in with your Claude Pro or Max plan, or an Anthropic API key.'}
        </p>
        <Callout tone="info" title="Mock only">
          This flow just flips the chip — the real sign-in happens through Claude Code itself.
        </Callout>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1 py-2">Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** An (i) explainer anchored to a heading — the app's SectionHeader pattern. */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <AnchorTip label={label} title={label} placement="bottom">
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-fg-faint text-fg-muted text-2xs font-bold hover:border-fg hover:text-fg">
        i
      </span>
    </AnchorTip>
  );
}

// ── The settings drawer row + mock drawer frame ─────────────────────────────

export function AssistantSettingsRow({ summary, onOpen }: { summary: string; onOpen: () => void }) {
  return (
    <SettingRow
      icon={
        <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3l9 5-9 5-9-5 9-5z" />
          <path d="M3 13l9 5 9-5" />
        </svg>
      }
      title="Assistant settings"
      description={summary}
      onClick={onOpen}
    />
  );
}

const PLACEHOLDER_ROWS: { icon: string; title: string; description?: string }[] = [
  { icon: '◎', title: 'Account', description: 'you@example.com' },
  { icon: '▣', title: 'Appearance', description: 'Midnight' },
  { icon: '◈', title: 'Buddy Floater', description: 'Off' },
  { icon: '♫', title: 'Sound', description: '30%' },
  { icon: '▦', title: 'Backup & Sync', description: 'Synced' },
  { icon: '⬡', title: 'Package Tier', description: 'Developer' },
  { icon: '⌁', title: 'Remote Access', description: 'Connected' },
  { icon: '⌥', title: 'Performance' },
  { icon: '{', title: 'Development' },
  { icon: '⌨', title: 'Keyboard Shortcuts' },
  { icon: 'ⓘ', title: 'About', description: 'v1.2.4' },
];

/** A mock settings drawer so the card/popup interaction reads in context.
 *  Only `row` (the live Assistant settings row) is interactive; the other rows
 *  are visual placeholders. Buddy Floater stays its OWN row (Destin's call). */
export function MockDrawer({ row, caption }: { row: React.ReactNode; caption?: string }) {
  return (
    <div className="h-full w-full flex items-start justify-center bg-canvas p-8 overflow-y-auto">
      <div className="w-80 shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge bg-panel rounded-t-xl">
          <div className="text-sm font-bold text-fg">Settings</div>
          <span className="text-fg-faint text-sm">✕</span>
        </div>
        <div className="bg-panel rounded-b-xl border border-edge-dim border-t-0 px-2 py-2 flex flex-col gap-1.5 shadow-lg">
          {PLACEHOLDER_ROWS.slice(0, 2).map((r) => (
            <SettingRow key={r.title} icon={<span className="w-4 h-4 flex items-center justify-center text-fg-muted text-xs">{r.icon}</span>} title={r.title} description={r.description} />
          ))}
          {row}
          {PLACEHOLDER_ROWS.slice(2).map((r) => (
            <SettingRow key={r.title} icon={<span className="w-4 h-4 flex items-center justify-center text-fg-muted text-xs">{r.icon}</span>} title={r.title} description={r.description} />
          ))}
        </div>
        <p className="text-3xs text-fg-faint mt-2 px-1">
          Mock drawer — only "Assistant settings" is interactive. Buddy Floater and every other row stay exactly as they are today.
          {caption ? ` ${caption}` : ''}
        </p>
      </div>
    </div>
  );
}
