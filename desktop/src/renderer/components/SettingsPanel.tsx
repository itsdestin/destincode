declare const __APP_VERSION__: string;
// Baked in by Vite from YOUCODED_BUILD_CHANNEL. '' for release builds, 'BETA'
// for desktop-test-build.yml artifacts. See src/shared/version-line.ts.
declare const __BUILD_CHANNEL__: string;
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { isAndroid } from '../platform';
import { useCurrentPlatform } from '../state/platform';
import ThemeScreen from './ThemeScreen';
import SyncSection from './SyncPanel';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import { useTheme } from '../state/theme-context';
import { MODELS } from './StatusBar';
import { CLOSE_PROMPT_SUPPRESS_KEY } from './CloseSessionPrompt';
import { ModelInfoTooltip } from './ModelPickerPopup';
import { useScrollFade } from '../hooks/useScrollFade';
import { Scrim } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import AboutPopup from './AboutPopup';
import { DevelopmentPopup } from './development/DevelopmentPopup';
import { BugReportPopup } from './development/BugReportPopup';
import { ContributePopup } from './development/ContributePopup';
import PerformanceButton from './PerformanceButton';
import AccountSection from './AccountSection';
import ModelProvidersSection from './ModelProvidersPopup';
import PermissionsSection from './PermissionsSection';
import SpecialistsSection, { SPECIALISTS_EXPLAINER_INTRO, SPECIALISTS_EXPLAINER_SECTIONS } from './SpecialistsSection';
import { PERMISSIONS_EXPLAINER_INTRO, PERMISSIONS_EXPLAINER_SECTIONS } from './permissions/permissions-explainer';
import { DonateConfirm } from './DonateConfirm';
import { formatVersionLine } from '../../shared/version-line';
// UiToggle is aliased because this file still exports its own `Toggle` (the
// compat wrapper below) that AboutPopup imports by that name.
import { Button, CloseButton, Toggle as UiToggle, TextInput, InputGroup, LoadingState, RadioGroup, SegmentedTabs, Dialog, SettingRow, Callout, StatusStrip, ErrorState, FieldError } from './ui';

// Both are Vite `define` substitutions, so they're constants at module scope.
// The typeof guard covers paths where the define isn't applied (unit tests).
const desktopVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
const desktopChannel = typeof __BUILD_CHANNEL__ !== 'undefined' ? __BUILD_CHANNEL__ : '';

// Plain-language explainer for the Remote Access popup. Shown when the user
// taps the (i) icon in the popup header — see RemoteButton's `showInfo` state.
const REMOTE_ACCESS_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Remote Access lets you use YouCoded from any phone, tablet, or other computer — even when you're across the world. Your main computer keeps doing all the actual work; the other device just shows you what's happening and lets you type.",
  sections: [
    {
      heading: 'What is Tailscale?',
      paragraphs: [
        "Tailscale is a free, secure tunnel that connects your devices like they're on the same WiFi, even when they're far apart. We use it because it's much safer than opening your computer to the open internet.",
        'You install it once on your main computer (that\'s what the "Set Up Remote Access" button does), then sign in with Google or GitHub. After that, you can scan a QR code on your phone to connect.',
      ],
    },
    {
      heading: 'What the settings do',
      bullets: [
        { term: 'Enabled', text: 'Turns the remote server on or off. When off, no other device can connect to this computer.' },
        { term: 'Password', text: "A short word or phrase you'll type on your phone or tablet to prove it's really you. Required by default." },
        { term: 'Keep awake', text: "Stops your computer from going to sleep so it stays ready to respond. Set to a few hours during a session, or 'Off' to let it sleep normally." },
        { term: 'Skip password on Tailscale', text: 'If a device is already on your private Tailscale network, you trust it and skip the password. Convenient, but only turn on if you trust everyone on your Tailscale.' },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: '"Tailscale not installed"', text: 'Click "Set Up Remote Access" and follow the prompts. It downloads about 50MB and asks you to sign in through a browser.' },
        { term: '"VPN not active"', text: 'Tailscale is installed but turned off. Open the Tailscale app on your computer and switch it on.' },
        { term: "Phone can't connect", text: 'Make sure Tailscale is also installed on your phone and signed in to the same account. Both devices need it running at the same time.' },
        { term: "QR code won't scan", text: 'Tap "Copy link" instead, send the link to your phone (text it to yourself), and open it in your phone\'s browser.' },
        { term: 'Forgot the password', text: 'Just type a new one into the password box and hit "Set". The old one is replaced — there\'s nothing to recover.' },
        { term: 'Connected device should be removed', text: 'Use the Disconnect button next to a device under "Connected Devices". They\'ll need the password again to reconnect.' },
      ],
    },
  ],
};

interface RemoteConfig {
  enabled: boolean;
  port: number;
  hasPassword: boolean;
  trustTailscale: boolean;
  keepAwakeHours: number;
  clientCount: number;
}

const KEEP_AWAKE_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '1h', value: 1 },
  { label: '4h', value: 4 },
  { label: '8h', value: 8 },
  { label: '24h', value: 24 },
];

interface TailscaleInfo {
  installed: boolean;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
  url: string | null;
}

interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  /** Run a slash command through the slash dispatcher — the path that reaches a
   *  native session's harness. onSendInput pipes raw text at a PTY those
   *  sessions do not have, which is why the theme-build button was dead there. */
  onRunCommand?: (command: string) => void;
  hasActiveSession: boolean;
  // Task 10: Settings → Specialists needs the active conversation's working
  // folder so the roster it shows includes that project's OWN .claude/agents
  // specialists, not just the two global sources. Undefined when there is no
  // active session — the section just shows the global sources then.
  // Desktop-only (see the DesktopSettings-only render below).
  activeSessionCwd?: string;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  // Opens Claude Code's preferences popup (/config). Consumed by the Model
  // Providers popup's Claude Code section. Desktop-only.
  onOpenClaudePreferences?: () => void;
  syncAutoOpen?: boolean;
  onSyncAutoOpenHandled?: () => void;
  // Deep-link the Model Providers popup open on panel mount — used by the
  // provider-error bubble's "Open Settings" jump. Desktop-only (the Model
  // Providers section isn't mounted in AndroidSettings).
  providersAutoOpen?: boolean;
  onProvidersAutoOpenHandled?: () => void;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// ─── Keyboard Shortcuts reference popup ──────────────────────────────────────

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: 'Ctrl + `', description: 'Toggle between chat and terminal' },   // P-7: 'view' trimmed so the label holds one line at 420px
  { keys: 'Ctrl + O', description: 'Expand / collapse all tool cards' },
  { keys: 'Shift (hold)', description: 'Open session switcher' },
  { keys: 'Shift + Arrow Up/Down', description: 'Navigate between sessions' },
  { keys: 'Shift (release)', description: 'Switch to highlighted session' },
  { keys: 'Arrow Up/Down', description: 'Scroll chat view' },
  { keys: 'Shift + Tab', description: 'Cycle permission mode' },
  { keys: 'Shift + Space', description: 'Cycle model' },
  { keys: 'Shift + Enter', description: 'Insert newline in input' },
  { keys: 'Enter', description: 'Send message' },
  { keys: '/', description: 'Open skill/command drawer' },
  { keys: 'Escape', description: 'Close drawer or modal' },
  { keys: 'Arrow Left/Right', description: 'Cycle permission prompt buttons' },
];

function ShortcutsPopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEscClose(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      {/* P-8/P-7 (2026-08-28): was size="prompt" (340px) with its own header and
          scrollBody={false} — at that width four labels wrapped to two lines AND
          the last three of the thirteen rows fell outside the dialog's 476px cap
          with no scroll region anywhere, so they could never be read. The shared
          header + scrolling body (scrollBody defaults true) fixes the reachability;
          "panel" (420px) stops the wrapping. The grid keeps the key chips in their
          own column so a long label can never push one out of line. */}
      <Dialog open onClose={onClose} size="panel" title="Keyboard Shortcuts">
        <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center">
          {SHORTCUTS.map(({ keys, description }) => (
            <React.Fragment key={keys}>
              <span className="text-2xs text-fg-dim py-1.5">{description}</span>
              <kbd className="justify-self-end text-3xs font-mono text-fg-2 bg-inset border border-edge-dim rounded px-1.5 py-0.5">{keys}</kbd>
            </React.Fragment>
          ))}
        </div>
      </Dialog>
    </>,
    document.body
  );
}

export default function SettingsPanel({ open, onClose, onSendInput, onRunCommand, hasActiveSession, activeSessionCwd, onOpenThemeMarketplace, onPublishTheme, onOpenClaudePreferences, syncAutoOpen, onSyncAutoOpenHandled, providersAutoOpen, onProvidersAutoOpenHandled }: Props) {
  useEscClose(open, onClose);
  // Slide polish: track animation window so CSS can reduce backdrop-filter cost
  // and suppress scrollbar-thumb while the 300ms transform is running. Also
  // keeps the Scrim mounted during the close animation so it can fade out
  // instead of popping. `hasOpened` prevents the first render from showing a
  // stale scrim before the user has ever opened the panel.
  const [animating, setAnimating] = useState(false);
  const [hasOpened, setHasOpened] = useState(open);
  const outerScrollRef = useScrollFade<HTMLDivElement>();
  useEffect(() => {
    if (open) setHasOpened(true);
    setAnimating(true);
    // Fallback timer in case transitionend doesn't fire (e.g., tab backgrounded).
    const t = setTimeout(() => setAnimating(false), 350);
    return () => clearTimeout(t);
  }, [open]);

  const scrimVisible = hasOpened && (open || animating);

  return (
    <>
      {/* Backdrop — L1 drawer scrim, theme-driven via <Scrim>. Kept mounted
          through the close animation so opacity can fade rather than pop. */}
      {scrimVisible && (
        <Scrim
          layer={1}
          onClick={onClose}
          style={{
            WebkitAppRegion: 'no-drag',
            opacity: open ? 1 : 0,
            transition: 'opacity 300ms ease-out',
            pointerEvents: open ? 'auto' : 'none',
          } as React.CSSProperties}
        />
      )}

      {/* Panel — outer handles slide animation (transform), inner carries
          .settings-drawer glass. backdrop-filter on a transformed element
          breaks sampling in Chrome; moving it to an untransformed child
          is the common workaround. `will-change: transform` promotes the
          layer up front so the first frame doesn't hitch on layer creation.
          `data-animating` drives CSS that reduces backdrop-filter cost and
          hides the scrollbar-thumb during the slide (both ramp back in via
          CSS transitions on transitionend). */}
      <div
        // max-sm:w-full — below 640px this becomes a full-screen page rather
        // than a 320px drawer. The flat w-80 was most of the "settings look
        // odd on mobile" problem: its own child popups already clamp to
        // min(380px, 88vw), so on a phone they rendered WIDER than the drawer
        // that launched them and straddled it, visually detached from the row
        // that was tapped. Full-width makes the drawer the widest surface again.
        className={`fixed top-0 left-0 h-full w-80 max-sm:w-full z-50 transform transition-transform duration-300 ease-out overlay-no-drag ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ WebkitAppRegion: 'no-drag', willChange: 'transform' } as React.CSSProperties}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'transform') setAnimating(false);
        }}
      >
        <div
          className="settings-drawer flex flex-col h-full border-r border-edge-dim"
          data-animating={animating ? 'true' : undefined}
        >
          {/* Header — sits outside the scrolling body so it doesn't fade when
              content scrolls. `settings-drawer-header` adds extra top padding
              on macOS so the title clears the native traffic lights (which
              sit at window top-left and can't be moved).

              Change 50 REVERSED (Destin, 2026-07-24, after seeing it in dev): the
              headerless drawer was approved on 2026-07-16 and built, then rejected
              on sight. Esc and click-outside do work, but the title row is what
              tells you WHICH drawer this is, and the ✕ is the affordance a
              non-technical user actually looks for. Design rule 12 therefore gets
              NO Settings-drawer exception — the drawer keeps its header like every
              other overlay. Do not re-delete this without asking.

              The ✕ itself does not revert: it comes back as the shared
              <CloseButton> rather than the bare `text-lg w-8 h-8` button it was,
              because every other closer in the app went through that component in
              tranche 2 (change 76). It also gains a focus ring and an accessible
              name — the old one announced as just "✕". */}
          <div className="settings-drawer-header shrink-0 flex items-center justify-between px-4 py-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Settings</h2>
            <CloseButton
              onClick={onClose}
              label="Close settings"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            />
          </div>

          <div ref={outerScrollRef} className="scroll-fade flex-1 min-h-0">
            {isAndroid() ? (
              <AndroidSettings open={open} onClose={onClose} onSendInput={onSendInput} onRunCommand={onRunCommand} onOpenThemeMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} syncAutoOpen={syncAutoOpen} onSyncAutoOpenHandled={onSyncAutoOpenHandled} />
            ) : (
              <DesktopSettings
                open={open}
                onClose={onClose}
                onSendInput={onSendInput}
                onRunCommand={onRunCommand}
                hasActiveSession={hasActiveSession}
                activeSessionCwd={activeSessionCwd}
                onOpenThemeMarketplace={onOpenThemeMarketplace}
                onPublishTheme={onPublishTheme}
                onOpenClaudePreferences={onOpenClaudePreferences}
                syncAutoOpen={syncAutoOpen}
                onSyncAutoOpenHandled={onSyncAutoOpenHandled}
                providersAutoOpen={providersAutoOpen}
                onProvidersAutoOpenHandled={onProvidersAutoOpenHandled}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Toggle component (shared) ──────────────────────────────────────────────
// Was a hand-rolled 32x16 track (green-600 on / red-600 for danger) with its own
// knob math; now a thin wrapper over the shared <Toggle> primitive so there is
// one 36x20 geometry app-wide (changes 15-17). Kept as a named export — and with
// its original `enabled`/`onToggle`/`color` signature — because AboutPopup's
// analytics opt-out imports `Toggle` from this file.
//
// color="red" maps to tone="danger" (the theme's destructive token, replacing the
// raw red-600); the default maps to the app accent, replacing green-600.

export function Toggle({ enabled, onToggle, color = 'green', label }: { enabled: boolean; onToggle: () => void; color?: 'green' | 'red'; label?: string }) {
  return (
    <UiToggle
      checked={enabled}
      // The primitive hands back the next state; every call site here is a plain
      // flip, so we discard it and keep the existing zero-arg handlers intact.
      onChange={() => onToggle()}
      tone={color === 'red' ? 'danger' : 'default'}
      // None of these switches had an accessible name before (a <button> inside a
      // <label> does not inherit one); call sites pass the visible row text.
      aria-label={label}
    />
  );
}


// ─── Sound settings popout ────────────────────────────────────────────────

import {
  SOUND_MUTED_KEY, SOUND_VOLUME_KEY,
  STOCK_PRESETS, CUSTOM_SOUND_ID,
  getSelectedPresetId, setSelectedPresetId, playPreview,
  getCustomSoundPath, setCustomSoundPath, getCustomSoundDisplayName,
  isCategoryEnabled, setCategoryEnabled,
  type SoundCategory,
} from '../utils/sounds';

/** Preset selector — stock sounds + custom sound file option.
 *
 *  Selecting a sound PLAYS it. That is deliberate (Destin's call 2026-07-26):
 *  with one shared list behind a category toggle, "assign" and "audition" are
 *  the same intent, so a separate play button was just a second thing to aim
 *  at. The whole tile is the hit target — the radio is a visual mark, not the
 *  only place you can click. */
function PresetSelector({ selectedId, onSelect, customName }: {
  selectedId: string;
  onSelect: (id: string) => void;
  customName: string | null; // display name of the custom sound file, if set
}) {
  // Option ids in visual order, so RadioGroup's arrow keys walk the same list
  // the user sees. The custom entry only exists once a file has been picked.
  const optionIds = customName
    ? [...STOCK_PRESETS.map((p) => p.id), CUSTOM_SOUND_ID]
    : STOCK_PRESETS.map((p) => p.id);

  // K2: these are `item` rows — one of N being chosen between — with the Radio
  // in the icon slot (K3's "any option needs a description" form). SettingRow
  // renders the Radio and keeps the whole tile as the hit target.
  return (
    <RadioGroup
      options={optionIds}
      value={selectedId}
      onChange={onSelect}
      aria-label="Notification sound"
      className="space-y-1"
    >
      {STOCK_PRESETS.map((p) => (
        <SettingRow
          key={p.id}
          variant="item"
          title={p.label}
          // The tone signature is data, not prose — font-mono keeps the note
          // names aligned down the list.
          description={p.desc}
          descriptionClassName="text-fg-muted font-mono"
          selected={selectedId === p.id}
          onSelect={() => onSelect(p.id)}
          radioTabIndex={selectedId === p.id ? 0 : -1}
        />
      ))}
      {/* Custom sound — only present once the user has picked a file. */}
      {customName ? (
        <SettingRow
          variant="item"
          title={customName}
          // The only unbounded title in the app — a filename the user chose.
          truncateTitle
          description="Custom sound"
          selected={selectedId === CUSTOM_SOUND_ID}
          onSelect={() => onSelect(CUSTOM_SOUND_ID)}
          radioTabIndex={selectedId === CUSTOM_SOUND_ID ? 0 : -1}
        />
      ) : null}
    </RadioGroup>
  );
}

/** A single sound category section within the popout */
function SoundCategorySection({ category, label, description, dotColor }: {
  category: SoundCategory;
  label: string;
  description: string;
  dotColor?: string; // Tailwind bg class for the status dot indicator
}) {
  const [enabled, setEnabled] = useState(() => isCategoryEnabled(category));
  const [presetId, setPresetId] = useState(() => getSelectedPresetId(category));
  const [customPath, setCustomPath] = useState(() => getCustomSoundPath(category));

  const handleToggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      setCategoryEnabled(category, next);
      return next;
    });
  }, [category]);

  // Selecting auditions it. Previously the only way to hear a stock sound was
  // to assign it, which was the bug; the fix is that assigning is now also how
  // you listen, rather than adding a second control to aim at.
  const handleSelect = useCallback((id: string) => {
    setPresetId(id);
    setSelectedPresetId(category, id);
    playPreview(id, category);
  }, [category]);

  // Pick a custom sound file via the system file picker
  const handlePickCustom = useCallback(async () => {
    try {
      const path = await window.claude.dialog.openSound();
      if (!path) return;
      setCustomSoundPath(category, path);
      setCustomPath(path);
      // Auto-select the custom sound after picking it
      setPresetId(CUSTOM_SOUND_ID);
      setSelectedPresetId(category, CUSTOM_SOUND_ID);
      // Preview it
      playPreview(CUSTOM_SOUND_ID, category);
    } catch { /* dialog cancelled or not available */ }
  }, [category]);

  // Clear custom sound
  const handleClearCustom = useCallback(() => {
    setCustomSoundPath(category, null);
    setCustomPath(null);
    // If custom was selected, fall back to first stock preset
    if (presetId === CUSTOM_SOUND_ID) {
      const fallback = STOCK_PRESETS[0].id;
      setPresetId(fallback);
      setSelectedPresetId(category, fallback);
    }
  }, [category, presetId]);

  const customName = customPath ? getCustomSoundDisplayName(customPath) : null;

  return (
    <section>
      {/* The category's name lives in the tab above; this row carries only its
          on/off switch and what it does. */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {dotColor && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />}
          <p className="text-3xs text-fg-muted">{description}</p>
        </div>
        <Toggle enabled={enabled} onToggle={handleToggle} label={label} />
      </div>
      {enabled && (
        <>
          <PresetSelector
            selectedId={presetId}
            onSelect={handleSelect}
            customName={customName}
          />
          {/* Custom sound controls */}
          <div className="flex items-center gap-2 mt-2">
            <Button variant="secondary" size="sm" onClick={handlePickCustom}>
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {customName ? 'Change file' : 'Custom sound'}
            </Button>
            {/* ghost, not danger-outline: this only clears a sound preference. */}
            {customName && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearCustom}
                title="Remove custom sound"
              >
                Remove
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Per-category copy for the sound popup's toggle. Keyed so the tab, the
 *  description and the status dot can never drift apart. */
const SOUND_CATEGORY_META: Record<SoundCategory, { label: string; description: string; dotColor: string }> = {
  attention: {
    label: 'Needs Attention',
    description: 'Plays when a session needs approval',
    dotColor: 'bg-red-400',
  },
  ready: {
    label: 'Response Ready',
    description: 'Plays when a background session has a new response',
    dotColor: 'bg-blue-400',
  },
};

/** Sound settings — compact row that opens a popout modal (matches ThemeButton pattern) */
function SoundButton() {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // Which notification the shared sound list is currently editing.
  const [soundCategory, setSoundCategory] = useState<SoundCategory>('attention');
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem(SOUND_MUTED_KEY) === '1'; } catch { return false; }
  });
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY) || '0.3');
      return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
    } catch { return 0.3; }
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem(SOUND_MUTED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    try { localStorage.setItem(SOUND_VOLUME_KEY, String(v)); } catch {}
  }, []);

  // Summary text for the compact row
  const summaryParts: string[] = [];
  if (muted) { summaryParts.push('Muted'); }
  else { summaryParts.push(`${Math.round(volume * 100)}%`); }

  return (
    <>
      <SettingRow
        icon={
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            {muted ? (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </>
            ) : (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                {volume > 0.5 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
              </>
            )}
          </svg>
        }
        title="Sound"
        description={summaryParts.join(' · ')}
        onClick={() => setOpen(true)}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Sound & Notifications"
        size="panel"
        panelRef={popupRef}
      >
                {/* Master volume */}
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Volume</h3>
                  <div className="flex items-center gap-3">
                    {/* Mute toggle */}
                    <button onClick={handleToggleMute} className="text-fg-muted hover:text-fg shrink-0">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        {muted ? (
                          <>
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                          </>
                        ) : (
                          <>
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </>
                        )}
                      </svg>
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      onChange={handleVolumeChange}
                      className="flex-1 h-1 accent-accent"
                    />
                    <span className="text-3xs text-fg-muted w-8 text-right">{Math.round(volume * 100)}%</span>
                  </div>
                </section>

                {/* One shared sound list behind a category toggle, rather than
                    two independent lists of the same 15 presets stacked on top
                    of each other. `key` remounts the section on switch so its
                    useState initializers re-read that category's saved values. */}
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Notification</h3>
                  <SegmentedTabs
                    variant="contained"
                    aria-label="Notification type"
                    value={soundCategory}
                    onChange={(id) => setSoundCategory(id as SoundCategory)}
                    tabs={[
                      { id: 'attention', label: 'Needs Attention' },
                      { id: 'ready', label: 'Response Ready' },
                    ]}
                    className="mb-3"
                  />
                  <SoundCategorySection
                    key={soundCategory}
                    category={soundCategory}
                    label={SOUND_CATEGORY_META[soundCategory].label}
                    description={SOUND_CATEGORY_META[soundCategory].description}
                    dotColor={SOUND_CATEGORY_META[soundCategory].dotColor}
                  />
                </section>
      </Dialog>
    </>
  );
}

// ─── Tier selector popup (Android) ────────────────────────────────────────

// ─── Theme popup button ────────────────────────────────────────────────────

/** Compact "Appearance" row — opens ThemeScreen in a centered popup modal */
function ThemeButton({ onSendInput, onRunCommand, onOpenMarketplace, onPublishTheme }: { onSendInput?: (text: string) => void; onRunCommand?: (command: string) => void; onOpenMarketplace?: () => void; onPublishTheme?: (slug: string) => void }) {
  const { activeTheme, allThemes } = useTheme();
  const [open, setOpen] = useState(false);
  // ThemeScreen fills this Dialog but does not own it, so it cannot reach the
  // shell's header. Both view flags live here and drive title/onBack; the
  // component gets them back as props. Same lift K12 did for `showInfo`,
  // extended to the theme editor so its header can go too.
  const [showInfo, setShowInfo] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const editingTheme = editingSlug ? (allThemes.find((t) => t.slug === editingSlug) ?? null) : null;
  const popupRef = useRef<HTMLDivElement>(null);

  const { canvas, panel, inset, accent } = activeTheme.tokens;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <>
      <SettingRow
        icon={
          <div className="flex rounded-sm overflow-hidden w-full h-full">
            <div style={{ flex: 1, background: canvas }} />
            <div style={{ flex: 1, background: panel }} />
            <div style={{ flex: 1, background: inset }} />
            <div style={{ flex: 1, background: accent }} />
          </div>
        }
        title="Appearance"
        description={activeTheme.name}
        onClick={() => setOpen(true)}
      />

      {/* D1: one header for all three of ThemeScreen's views. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={
          showInfo ? 'About Appearance'
            : editingTheme ? `Edit: ${editingTheme.name}`
              : 'Themes'
        }
        onBack={
          showInfo ? () => setShowInfo(false)
            : editingTheme ? () => setEditingSlug(null)
              : undefined
        }
        headerActions={!showInfo && !editingTheme ? <InfoIconButton onClick={() => setShowInfo(true)} /> : undefined}
        aria-label="Appearance"
        // A panel, not a document. Its theme cards are a 6px gradient strip and
        // a truncated name -- there is no canvas to size for, so the grid sets
        // no meaningful width floor. At panel width the 2-up cards are 194px,
        // which is ample for a strip plus a label and two 20px icons. Sizing it
        // as a document made it 600px wide for content that needed none of it.
        size="panel"
        fill
        panelRef={popupRef}
      >
        <ThemeScreen
          onClose={() => setOpen(false)}
          onSendInput={onSendInput}
          onRunCommand={onRunCommand}
          onOpenMarketplace={onOpenMarketplace}
          onPublishTheme={(slug) => { setOpen(false); onPublishTheme?.(slug); }}
          showInfo={showInfo}
          editingSlug={editingSlug}
          onEditSlug={setEditingSlug}
        />
      </Dialog>
    </>
  );
}

// ─── Buddy floater button ──────────────────────────────────────────────────
// Row + popup that controls the buddy mascot window: off by default, persists
// via localStorage['youcoded-buddy-enabled'] (matches theme/font persistence
// pattern). Toggling fires window.claude.buddy.show/hide; App.tsx also reads
// the flag on mount to auto-show if previously enabled. Follows the same
// row-opens-popup pattern as Sound/Appearance/Remote Access instead of being
// a bare checkbox — see docs/active/specs/2026-07-15-settings-panel-card-redesign-design.md.
function BuddyIcon() {
  // Simplified outline mascot silhouette (rounded head + dot eyes + arm/leg
  // stubs) — deliberately NOT the full WelcomeAppIcon/AppIcon/ThemeMascot
  // illustration, which is too detailed for a 16px monochrome row icon.
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="4" width="14" height="12" rx="4" />
      <circle cx="9.3" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <path d="M2 9v3M22 9v3" />
      <path d="M9 20h2M13 20h2" />
    </svg>
  );
}

// Fix: the buddy floater is desktop-Electron only, and every buddy method on
// remote-shim is an error-THROWING stub — `?.` guards existence, not throwing,
// so getStatus() below threw straight out of the mount effect (synchronously,
// before .catch could ever attach) and took the app down via RootErrorBoundary.
// Rather than sprinkle try/catch over four call sites, don't render a
// desktop-only control on clients that can't use it. window.claude.window is
// the Electron-only surface the shim deliberately omits; getPlatform() is not
// usable because the shim sets __PLATFORM__ to the host's 'desktop' on auth:ok.
const isDesktopShell = () => !!(window as any).claude?.window;

function BuddyButton() {
  const [enabled, setEnabled] = useState<boolean>(() =>
    localStorage.getItem('youcoded-buddy-enabled') === '1',
  );
  // "Hidden until restart": the bar's hide button dismisses the buddy for
  // this run only (localStorage preference untouched). Main broadcasts
  // buddy:status-changed so this row updates live, with an inline Show-now
  // recovery (show() clears the dismissed flag main-side).
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // Task 8: KDE-only "pin above other windows" toggle. Gated on the real OS
  // platform (not the app-shell 'electron'/'android'/'browser' axis in
  // ../platform) since it must not render on Windows/macOS desktop builds.
  const platform = useCurrentPlatform();
  const [keepAboveEnabled, setKeepAboveEnabled] = useState(false);
  // Transient, non-persisted: set when a toggle action's setKeepAbove
  // resolves false (KWin unreachable right now), cleared on the next
  // successful apply or when the popup is reopened. Never a guessed cause —
  // see toggleKeepAbove below for why this specific copy is accurate.
  const [keepAboveHint, setKeepAboveHint] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktopShell()) return;
    let alive = true;
    window.claude.buddy?.getStatus?.()
      .then((s: { dismissed: boolean; keepAbove?: boolean }) => {
        if (!alive) return;
        setDismissed(!!s?.dismissed);
        setKeepAboveEnabled(!!s?.keepAbove);
      })
      .catch(() => {});
    const off = window.claude.buddy?.onStatusChanged?.(
      (s: { dismissed: boolean }) => setDismissed(!!s?.dismissed),
    );
    return () => { alive = false; off?.(); };
  }, []);

  // Controller ruling (2026-07-22): the toggle is a saved PREFERENCE, not a
  // live KWin-state indicator — the plan copy itself ("KDE only. No effect
  // on other desktops.") already establishes that semantics, and it must
  // display/persist the user's request in both directions, exactly like
  // `toggle` below and like getStatus()'s mount re-hydration (which reads
  // the persisted request, not a live probe).
  //
  // Reconciling the visual state against applyKwinKeepAbove's result was
  // tried and rejected in two forms: symmetric revert makes the toggle
  // permanently un-flippable on GNOME (every apply resolves false, so it
  // would always snap back); asymmetric (enable-only) revert let a failed
  // OFF silently display "off" while the window stayed pinned — a new,
  // opposite contradiction, not a fix (see the WHY comment on
  // BuddyOverlayManager's applyKeepAbove call site for why that stale-
  // pinned edge is acceptable to just leave alone).
  //
  // So: flip and keep the local state unconditionally. The REAL result only
  // drives a transient, honest inline hint — never a guessed cause (Destin's
  // error-message rule): `false` means exactly "qdbus was missing or the
  // DBus call failed", which is what the copy below says, nothing more.
  const toggleKeepAbove = useCallback(() => {
    const next = !keepAboveEnabled;
    setKeepAboveEnabled(next);
    const KWIN_UNREACHABLE_HINT =
      "Couldn't reach KWin — the preference is saved; it's applied whenever the buddy window is (re)created on KDE Plasma.";
    window.claude.buddy?.setKeepAbove?.(next)
      .then((ok: boolean) => setKeepAboveHint(ok ? null : KWIN_UNREACHABLE_HINT))
      .catch(() => setKeepAboveHint(KWIN_UNREACHABLE_HINT));
  }, [keepAboveEnabled]);

  // The hint describes the last toggle action, not persistent state —
  // clear it whenever the popup is reopened so a stale failure from a
  // previous session/click doesn't linger indefinitely.
  useEffect(() => {
    if (open) setKeepAboveHint(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem('youcoded-buddy-enabled', next ? '1' : '0');
    if (next) window.claude.buddy?.show?.();
    else window.claude.buddy?.hide?.();
  }, [enabled]);

  const showNow = useCallback(() => {
    window.claude.buddy?.show?.(); // show() clears the dismissed flag main-side
  }, []);

  const status = !enabled
    ? 'Off'
    : dismissed
    ? 'Hidden until restart'
    : 'On — floating on your desktop';

  // Desktop-only control: hidden on remote/Android, where every buddy method
  // throws. Placed after all hooks so hook order stays unconditional.
  if (!isDesktopShell()) return null;

  return (
    <>
      <SettingRow
        icon={<BuddyIcon />}
        title="Buddy Floater"
        description={status}
        onClick={() => setOpen(true)}
      />

      {/* maxHeight="none" preserves this one's existing behavior — it was the only
          popup of the seven with no height ceiling, and it has no scroll container,
          so inheriting the shell's 80vh default would silently CLIP the Linux
          keep-above row instead of letting the popup grow. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Buddy Floater"
        size="prompt"
        scrollBody={false}
        panelRef={popupRef}
      >
            {/* K2: this popup was the worst offender in the app — it used TWO
                different description placements within itself (one <p> below the
                row, one <p> inside the left column). Both are left-column
                descriptions now, and the border-t between them goes: the rows
                are carded, so the rule was drawing a line between two things
                that were already separated. */}
            <div className="px-4 py-4 space-y-2">
              <SettingRow
                variant="item"
                title="Show buddy floater"
                description={
                  <>
                    A small always-on-top mascot that stays visible even when the app is minimized.
                    {enabled && dismissed && (
                      <>
                        <br />
                        Hidden until restart{' · '}
                        <button onClick={showNow} className="text-accent hover:underline">Show now</button>
                      </>
                    )}
                  </>
                }
                control={<Toggle enabled={enabled} onToggle={toggle} label="Show buddy floater" />}
              />
              {/* Task 8: Linux-only — Electron's setAlwaysOnTop is a no-op on
                  Wayland; this opt-in runs a KWin scripting DBus call instead,
                  which only does anything on KDE Plasma (see kwin-keep-above.ts). */}
              {platform === 'linux' && (
                <SettingRow
                  variant="item"
                  title="Pin buddy above other windows (KDE only)"
                  description={
                    <>
                      Requires KDE Plasma. No effect on other desktops.
                      {/* Honest, non-committal per-action feedback — NOT the toggle's
                          own state (that's the preference, above). Only appears right
                          after a click that couldn't reach KWin; see toggleKeepAbove. */}
                      {keepAboveHint && (
                        <>
                          <br />
                          {keepAboveHint}
                        </>
                      )}
                    </>
                  }
                  control={<Toggle enabled={keepAboveEnabled} onToggle={toggleKeepAbove} label="Pin buddy above other windows" />}
                />
              )}
            </div>
      </Dialog>
    </>
  );
}

// ─── Remote settings popup button ─────────────────────────────────────────

interface RemoteButtonProps {
  config: RemoteConfig | null;
  tailscale: TailscaleInfo | null;
  clients: ClientInfo[];
  loading: boolean;
  hasActiveSession: boolean;
  newPassword: string;
  passwordStatus: 'idle' | 'saving' | 'saved';
  copied: boolean;
  showSetupQR: boolean;
  showAddDevice: boolean;
  onSetNewPassword: (v: string) => void;
  onSetPassword: () => void;
  onToggleEnabled: () => void;
  /** Why the server refused to start, shown under the Enabled toggle. */
  enableError: string;
  onToggleTailscaleTrust: () => void;
  onSetKeepAwake: (hours: number) => void;
  onRunSetup: () => void;
  onConfirmSetup: () => void;
  onCancelSetup: () => void;
  setupStatus: 'idle' | 'confirm' | 'installing' | 'authenticating' | 'done' | 'error';
  setupError: string;
  onDisconnectClient: (id: string) => void;
  onCopyLink: () => void;
  onSetShowSetupQR: (v: boolean) => void;
  onSetShowAddDevice: (v: boolean) => void;
  /**
   * Opens the app's existing bug-report surface (BugReportPopup, which wraps
   * dev:summarize-issue + dev:submit-issue). Both actions on a general
   * ErrorState land here: "Report bug" files it, "Diagnose with Claude" is the
   * same popup's summarize path, which collects the logs. One destination, no
   * invented flow.
   */
  onReportIssue: () => void;
}

function RemoteButton({
  config, tailscale, clients, loading,
  newPassword, passwordStatus, copied, showSetupQR, showAddDevice,
  onSetNewPassword, onSetPassword, onToggleEnabled, enableError, onToggleTailscaleTrust,
  onSetKeepAwake, onRunSetup, onConfirmSetup, onCancelSetup, setupStatus, setupError, onDisconnectClient, onCopyLink,
  onSetShowSetupQR, onSetShowAddDevice, onReportIssue,
}: RemoteButtonProps) {
  const [open, setOpen] = useState(false);
  // showInfo flips the popup body to the plain-language explainer view.
  // Reset to false whenever the popup re-opens so users always start on the
  // main settings, not whichever screen they last viewed.
  const [showInfo, setShowInfo] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // No scroll ref here any more — Dialog owns the scroll region and its edge
  // fades for both views.

  useEffect(() => {
    if (!open) setShowInfo(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasClients = clients.length > 0;
  // Green: enabled + Tailscale installed + VPN active. Gray otherwise (disabled, or VPN not connected).
  const isFullyConnected = config?.enabled && tailscale?.installed && tailscale?.connected;
  const statusText = loading
    ? 'Loading...'
    : !config?.enabled
      ? 'Disabled'
      : isFullyConnected
        ? hasClients
          ? `Connected · ${clients.length} client${clients.length > 1 ? 's' : ''}`
          : 'Connected'
        : tailscale?.installed
          ? 'Tailscale VPN not active'
          : 'Enabled · No Tailscale';

  // Tailscale is the transport under a fully-connected session — the old UI
  // showed a separate "Tailscale" tag next to the title whenever installed;
  // folding it into the subtitle only when it adds information (fully
  // connected) avoids a redundant "Tailscale VPN not active · Tailscale".
  const subtitle = isFullyConnected ? `${statusText} · Tailscale` : statusText;

  return (
    <>
      <SettingRow
        // Status indicator dot — green when remote + Tailscale VPN fully active, gray otherwise
        icon={<div className={`w-2.5 h-2.5 rounded-full ${isFullyConnected ? 'bg-green-500' : 'bg-fg-muted/40'}`} />}
        title="Remote Access"
        description={subtitle}
        onClick={() => setOpen(true)}
      />

      {/* D1, finished: BOTH views use the shell's header and scroll body now.
          The main view used to paint its own — an h2, a CloseButton, and a
          `.scroll-fade flex-1` wrapper — which is the exact set of things D1
          exists to own, and the exact set two of SettingsPopup's seven callers
          got wrong. `space-y-6` rather than Dialog's default `space-y-5`, so
          the section rhythm here is unchanged. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={showInfo ? 'About Remote Access' : 'Remote Access'}
        onBack={showInfo ? () => setShowInfo(false) : undefined}
        headerActions={showInfo ? undefined : <InfoIconButton onClick={() => setShowInfo(true)} />}
        size="panel"
        fill
        panelRef={popupRef}
      >
            {showInfo ? (
              <SettingsExplainer
                intro={REMOTE_ACCESS_EXPLAINER.intro}
                sections={REMOTE_ACCESS_EXPLAINER.sections}
              />
            ) : (
            <div className="space-y-6">
                {loading ? (
                  <LoadingState what="remote access" />
                ) : (
                  <>
                    {/* Setup banner — shown when no clients connected */}
                    {!hasClients && (
                      // Info callouts are accent-tinted, warnings are amber. The
                      // amber "setup required" boxes below stay amber — they're a
                      // true warning status, not information.
                      <div className="bg-accent/10 border border-accent/25 rounded-lg p-3">
                        <p className="text-xs text-fg-2 mb-2">
                          Remote access lets you use YouCoded from any device — phone, tablet, or another computer.
                        </p>

                        {tailscale?.installed && tailscale.url && config?.hasPassword ? (
                          showSetupQR ? (
                            <div className="mt-2">
                              {/* Remind users that Tailscale must be installed + running on the receiving device too */}
                              <Callout tone="warning" title="Before scanning:" className="mb-2">
                                Download Tailscale on your other device, sign in to the same account, and make sure it&apos;s running. The page won&apos;t load without it.
                              </Callout>
                              <p className="text-3xs text-fg-muted mb-2">Then scan to connect:</p>
                              <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                                <QRCodeSVG value={tailscale.url} size={140} />
                              </div>
                              <p className="text-3xs text-fg-muted mt-2 text-center font-mono">{tailscale.url}</p>
                              <Button variant="secondary" size="sm" onClick={onCopyLink} className="w-full mt-2">
                                {copied ? 'Copied!' : 'Copy link'}
                              </Button>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {/* Persistent reminder — visible whenever Tailscale is ready but no device has connected yet */}
                              <Callout tone="warning" title="Other device setup required:">
                                Download Tailscale on your other device, sign in to the same account, and make sure it&apos;s running before scanning. The page won&apos;t load without it.
                              </Callout>
                              {/* Was bg-blue-600 with NO text-color class, so the
                                  label inherited the theme fg — near-black on blue
                                  on Creme. Button primary carries text-on-accent. */}
                              <Button onClick={() => onSetShowSetupQR(true)} className="w-full">
                                Set Up Remote Access
                              </Button>
                            </div>
                          )
                        ) : setupStatus === 'confirm' ? (
                          <div className="space-y-2">
                            <p className="text-3xs text-fg-2 text-center">This will download and install Tailscale (~50MB) for secure remote access.</p>
                            <div className="flex gap-2">
                              <Button variant="secondary" onClick={onCancelSetup} className="flex-1">Cancel</Button>
                              <Button onClick={onConfirmSetup} className="flex-1">Install</Button>
                            </div>
                          </div>
                        ) : setupStatus === 'installing' ? (
                          // K5. Every branch below was its own shape: centred
                          // green text, centred muted text, a bare button with no
                          // message at all. The WORDS were mostly fine — seven of
                          // eleven carry over verbatim. It was eleven shapes.
                          <StatusStrip tone="busy" detail="This may take a few minutes">
                            Installing Tailscale…
                          </StatusStrip>
                        ) : setupStatus === 'authenticating' ? (
                          <StatusStrip tone="busy" detail="Check your browser to sign in to Tailscale">
                            Waiting for Tailscale sign-in…
                          </StatusStrip>
                        ) : setupStatus === 'done' ? (
                          // Was "Tailscale installed and connected!" — the only
                          // exclamation mark in the settings family. A status
                          // strip says what you can do next (Destin, 2026-07-28).
                          <StatusStrip tone="ok">Tailscale is connected. You can pair a device now.</StatusStrip>
                        ) : setupStatus === 'error' ? (
                          // `{setupError || 'Setup failed'}` replaced a missing
                          // reason with a hardcoded guess and left the user two
                          // words and no next step — the exact pattern
                          // docs/error-message-standards.md forbids. When we HAVE
                          // the real reason we show it with Retry; when we do not,
                          // we say so without inventing a cause and hand over the
                          // two actions the standard mandates.
                          setupError ? (
                            <ErrorState
                              mode="recoverable"
                              message={setupError}
                              onRetry={onRunSetup}
                              variant="inline"
                            />
                          ) : (
                            <ErrorState
                              mode="general"
                              title="Unable to set up remote access."
                              explainer="The Tailscale installer didn't report a reason. Diagnosing will collect the setup log so Claude can look at what happened."
                              onReportBug={onReportIssue}
                              onDiagnose={onReportIssue}
                            />
                          )
                        ) : tailscale?.installed && !tailscale.connected ? (
                          // Fix: Tailscale is installed but VPN is off — tailscale.url is null in this state,
                          // so we used to fall through to the install-button branch and pretend it wasn't installed.
                          <StatusStrip tone="warn">
                            Tailscale is installed, but the VPN isn&apos;t active. Open the Tailscale app and turn it on, then come back here.
                          </StatusStrip>
                        ) : tailscale?.installed && !config?.hasPassword ? (
                          // Installed + connected but no password yet — guide the user down to the password field
                          // rather than re-prompting to install.
                          <StatusStrip tone="warn">
                            Set a password below to finish enabling remote access.
                          </StatusStrip>
                        ) : (
                          // Was a bare button with no message. A status strip
                          // says what state you are in, then offers the way out.
                          <StatusStrip
                            tone="idle"
                            action={<Button size="sm" onClick={onRunSetup}>Set up</Button>}
                          >
                            Not set up yet.
                          </StatusStrip>
                        )}
                      </div>
                    )}

                    {/* Server settings */}
                    <section>
                      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Server</h3>

                      {/* onClick keeps the whole-row hit target the <label> used
                          to give this; SettingRow stops the toggle's own click
                          from bubbling back into it. */}
                      <SettingRow
                        variant="item"
                        title="Enabled"
                        onClick={onToggleEnabled}
                        control={<Toggle enabled={!!config?.enabled} onToggle={onToggleEnabled} label="Remote access server enabled" />}
                      />
                      {/* The server is started from the toggle now, so it can fail
                          (port already bound, permission denied). Show the real
                          reason here — the toggle has already snapped back off. */}
                      {enableError && (
                        <FieldError as="p" size="2xs" className="pb-2">{enableError}</FieldError>
                      )}

                      <div className="py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-fg-2">Password</span>
                          {config?.hasPassword && (
                            <span className="text-3xs text-green-400">Set</span>
                          )}
                        </div>
                        {/* The Set button moves INSIDE the field (change 77): this is a
                            field with a single submit action, which is exactly the
                            InputGroup shape. The field also loses its bg-well surface,
                            rounded-sm radius, and gray focus:border-fg-muted. */}
                        <InputGroup size="sm">
                          <InputGroup.Field
                            type="password"
                            placeholder={config?.hasPassword ? 'Change password...' : 'Set password...'}
                            value={newPassword}
                            onChange={(e) => onSetNewPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && onSetPassword()}
                            aria-label="Remote access password"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={onSetPassword}
                            disabled={!newPassword.trim() || passwordStatus === 'saving'}
                          >
                            {passwordStatus === 'saved' ? '✓' : passwordStatus === 'saving' ? '...' : 'Set'}
                          </Button>
                        </InputGroup>
                      </div>

                      <div className="py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-fg-2">Keep awake</span>
                        </div>
                        {/* K3: four short options -> segmented. SegmentedTabs keys
                            on string ids and keepAwakeHours is a number, so both
                            directions convert at the boundary. */}
                        <SegmentedTabs
                          variant="contained"
                          aria-label="Keep awake"
                          value={String(config?.keepAwakeHours ?? 0)}
                          onChange={(id) => onSetKeepAwake(Number(id))}
                          tabs={KEEP_AWAKE_OPTIONS.map((opt) => ({
                            id: String(opt.value),
                            label: opt.label,
                          }))}
                        />
                      </div>
                    </section>

                    {/* Add Device — requires Tailscale running, otherwise tailscale.url is null.
                        Was a soft-blue tinted outline (bg-blue-500/10 + text-blue-400) that matched
                        no variant. Destin's call (spec §11.8 A): plain `secondary`. Unlike the
                        orange billing button, nothing here is a warning — the blue was decorative,
                        not signal. */}
                    {tailscale?.installed && tailscale?.connected && tailscale?.url && config?.hasPassword && (
                      <Button
                        onClick={() => onSetShowAddDevice(!showAddDevice)}
                        variant="secondary"
                        className="w-full py-2"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        Add Device
                      </Button>
                    )}

                    {/* Remote Clients section */}
                    {hasClients && (
                      <section>
                        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Connected Devices</h3>

                        <div className="space-y-1">
                          {clients.map(client => (
                            // K6: an item list is a K2 row with a status dot in
                            // the icon slot. The action was a bare ✕ with no
                            // accessible name and no focus ring — change 41
                            // banned those app-wide and this one survived the
                            // sweep, announcing itself to a screen reader as
                            // the literal character.
                            <SettingRow
                              key={client.id}
                              variant="item"
                              icon={<span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />}
                              title={client.ip}
                              description={timeAgo(client.connectedAt)}
                              control={
                                <Button variant="ghost" size="sm" onClick={() => onDisconnectClient(client.id)}>
                                  Disconnect
                                </Button>
                              }
                            />
                          ))}
                        </div>
                      </section>
                    )}

                    {/* Add Device overlay */}
                    {showAddDevice && tailscale?.url && (
                      <section className="bg-inset/50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-medium text-fg-2">Add Device</h3>
                          {/* NOT a K6 action — this dismisses the whole
                              sub-panel, so it is a CloseButton, which already
                              carries a label and a focus ring. */}
                          <CloseButton onClick={() => onSetShowAddDevice(false)} label="Close Add Device" />
                        </div>
                        {/* Remind users that Tailscale must be installed + running on the receiving device too */}
                        <Callout tone="warning" title="Before scanning:" className="mb-2">
                          Download Tailscale on your other device, sign in to the same account, and make sure it&apos;s running. The page won&apos;t load without it.
                        </Callout>
                        <p className="text-3xs text-fg-muted mb-2">Then scan QR or copy link to connect:</p>
                        <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                          <QRCodeSVG value={tailscale.url} size={140} />
                        </div>
                        <p className="text-3xs text-fg-muted mt-2 text-center font-mono">{tailscale.url}</p>
                        <Button variant="secondary" onClick={onCopyLink} className="w-full mt-2">
                          {copied ? 'Copied!' : 'Copy Link'}
                        </Button>
                      </section>
                    )}

                    {/* Tailscale section */}
                    <section>
                      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Tailscale</h3>

                      {tailscale?.installed ? (
                        // space-y-1 replaces the py-2 each bare row used to carry
                        // its own spacing with — the rows are carded now, so the
                        // gap belongs between them, not inside them.
                        <div className="space-y-1">
                          {/* Distinguish "installed and connected" from "installed but VPN off" —
                              previously detection conflated the two and forced the not-installed branch. */}
                          {/* K2 value rows. Status keeps its green/muted colour —
                              that is state, not chrome — but takes the value
                              slot's size so it lines up with the IP below it
                              instead of sitting a step smaller. */}
                          <SettingRow
                            variant="item"
                            title="Status"
                            value={
                              tailscale.connected ? (
                                <span className="text-green-400">
                                  Connected{tailscale.hostname ? ` · ${tailscale.hostname}` : ''}
                                </span>
                              ) : (
                                <span className="text-fg-muted">VPN not active</span>
                              )
                            }
                          />
                          <SettingRow variant="item" title="IP" value={tailscale.ip ?? '—'} />
                          <SettingRow
                            variant="item"
                            title="Skip password on Tailscale"
                            onClick={onToggleTailscaleTrust}
                            control={<Toggle enabled={!!config?.trustTailscale} onToggle={onToggleTailscaleTrust} label="Skip password on Tailscale" />}
                          />
                        </div>
                      ) : (
                        <div className="py-2">
                          <p className="text-xs text-fg-muted mb-2">
                            Tailscale is not installed. It creates a secure private network so you can access YouCoded from anywhere.
                          </p>
                          <Button
                            variant="secondary"
                            onClick={onRunSetup}
                            disabled={setupStatus === 'installing' || setupStatus === 'authenticating'}
                          >
                            {setupStatus === 'installing' ? 'Installing...' : setupStatus === 'authenticating' ? 'Authenticating...' : 'Install Tailscale'}
                          </Button>
                        </div>
                      )}
                    </section>
                  </>
                )}
            </div>
            )}
      </Dialog>
    </>
  );
}

// ─── Defaults popup button ────────────────────────────────────────────────

const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus',
  haiku: 'Haiku',
  fable: 'Fable',
};

interface PermissionOverrides {
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

function SkipPermissionsSection({ defaults, onDefaultsChange }: {
  defaults: { skipPermissions: boolean; permissionOverrides?: PermissionOverrides };
  onDefaultsChange: (updates: any) => void;
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
      {/* K2: "Skip Permissions" was a K1 SECTION LABEL doing a row title's job —
          an uppercase eyebrow heading labelling a single control. K1's rule is
          that a section label never labels one control; if a control needs a
          label, it is this row's title. The consequence line was the other
          retired shape (a <p> below the whole row); it belongs in the left
          column under the title, where every other description lives. */}
      {/* K9 — danger zone. One shape: a "Danger zone" K1 label, the consequence
          in a K4 danger callout, and the control, callout and control kept
          together.

          TWO DOCUMENTED DEVIATIONS, both approved 2026-07-28:

          1. PLACEMENT. K9 says a danger zone is always LAST in its menu; this
             one stays mid-menu. The rule exists so you cannot stumble into a
             destructive ACTION, and a toggle you must deliberately flip is a
             different risk from a Delete button — moving the most important
             setting in Session Defaults to the bottom would de-emphasise it to
             buy consistency that protects against nothing here.

          2. ORDER. The callout sits AFTER the control, not before it. K9's
             order assumes a button ("read this, then press"); for a toggle the
             sentence is a consequence of the state you just turned on, and it
             only exists while the toggle is on. Above the row it would push the
             control down every time you flipped it. */}
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Danger zone</h3>
      <SettingRow
        variant="item"
        title="Skip Permissions"
        description="New sessions will skip tool approval"
        control={
          <Toggle
            enabled={defaults.skipPermissions}
            onToggle={() => onDefaultsChange({ skipPermissions: !defaults.skipPermissions })}
            color="red"
            label="Skip Permissions"
          />
        }
      />
      {defaults.skipPermissions && (
        // Was a raw `text-[#DD4444]` span inside the row's description — the
        // fixed status red, which theme packs cannot restyle. The Callout's
        // danger tone rides the destructive token instead (change 17).
        <Callout tone="danger" className="mt-2">
          Claude will execute tools without asking for approval.
        </Callout>
      )}
      {defaults.skipPermissions && (
        <>
          {/* Advanced expandable section */}
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center gap-1.5 mt-3 group"
          >
            <svg
              className="w-3 h-3 text-fg-faint transition-transform"
              style={{ transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
              strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-3xs text-fg-muted group-hover:text-fg-2 transition-colors">Advanced</span>
          </button>

          {advancedOpen && (
            <div className="mt-2 ml-1 border-l border-edge-dim pl-3 space-y-3">
              {/* Approve All toggle. K2: these were text-3xs/text-4xs — a third
                  and fourth type size used to signal nesting depth. The indent
                  rail to the left already says "nested"; the rows take the one
                  item density like every other in-menu row. */}
              <SettingRow
                variant="item"
                title="Auto-approve all"
                description="Silently approve all protected requests"
                control={<Toggle enabled={overrides.approveAll} onToggle={handleApproveAllToggle} color="red" label="Auto-approve all" />}
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
                  control={<Toggle enabled={overrides[key]} onToggle={() => updateOverride(key, !overrides[key])} label={`Auto-approve ${label}`} />}
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
                // The `&#9888;` glyph goes with the hand-rolled header the spec
                // named. HTML entities do not decode inside a string PROP (only
                // in JSX text), so carrying it here would have rendered the
                // literal characters — and Dialog's `destructive` already tints
                // the whole panel, which is the same signal without the glyph.
                title="This is extremely dangerous"
                scrollBody={false}
              >
                <div className="px-4 py-3 space-y-2">
                  {/* K9: this was the hand-rolled block the spec named — a
                      `bg-red-600/10` header strip carrying a `&#9888;` glyph and
                      an `text-[#DD4444]` heading, which is a FOURTH red beside
                      the destructive token, the fixed status red, and the
                      red-600 the strip itself used. The title is Dialog's now
                      (with `destructive`, which already tints the panel) and the
                      consequence is a danger Callout. Copy is unchanged
                      throughout — it was specific, it was accurate, and it is
                      the strongest warning in the app for good reason. */}
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
                    {/* Change 59: was stock bg-red-600/70 + text-white — a second
                        red beside the app's #DD4444, and white-on-pale on packs
                        that soften --destructive. Filled danger commits. */}
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

interface DefaultsButtonProps {
  defaults: { skipPermissions: boolean; model: string; projectFolder: string; permissionOverrides?: PermissionOverrides };
  onDefaultsChange: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string; permissionOverrides: PermissionOverrides }>) => void;
}

function DefaultsButton({ defaults, onDefaultsChange }: DefaultsButtonProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // Close-session prompt suppression — reads/writes localStorage directly since
  // this is a UI preference, not a session default backed by sessionDefaults.
  const [closePromptDisabled, setClosePromptDisabled] = useState(
    () => localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1',
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleBrowseFolder = useCallback(async () => {
    try {
      const folder = await (window as any).claude.dialog.openFolder();
      if (folder) onDefaultsChange({ projectFolder: folder });
    } catch {}
  }, [onDefaultsChange]);

  const summaryParts: string[] = [];
  summaryParts.push(MODEL_LABELS[defaults.model] || 'Sonnet');
  if (defaults.skipPermissions) summaryParts.push('Skip Perms');

  return (
    <>
      <SettingRow
        icon={
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="7" x2="20" y2="7" /><circle cx="8" cy="7" r="2.2" fill="var(--panel)" />
            <line x1="4" y1="17" x2="20" y2="17" /><circle cx="16" cy="17" r="2.2" fill="var(--panel)" />
          </svg>
        }
        title="Defaults"
        description={summaryParts.join(' · ')}
        onClick={() => setOpen(true)}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Session Defaults"
        size="panel"
        panelRef={popupRef}
      >
                {/* Default Model */}
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Default Model</h3>
                  {/* K3: three short options -> segmented. The info tooltip
                      rides in the label, which is a ReactNode. */}
                  <SegmentedTabs
                    variant="contained"
                    aria-label="Default Model"
                    value={defaults.model}
                    onChange={(id) => onDefaultsChange({ model: id })}
                    tabs={MODELS.map((m) => ({
                      id: m,
                      label: (
                        <>
                          {MODEL_LABELS[m] || m}
                          <ModelInfoTooltip model={m} />
                        </>
                      ),
                    }))}
                  />
                </section>

                {/* Skip Permissions */}
                <SkipPermissionsSection defaults={defaults} onDefaultsChange={onDefaultsChange} />

                {/* Default Project Folder.

                    K7: this was a <button> wearing the FIELD surface — bg-inset,
                    border-edge-dim, rounded-md — so it read as a text box you
                    could type into, and nothing about it said "this opens a
                    folder picker". A value chosen ELSEWHERE (an OS dialog, a
                    picker, another screen) is a value row plus a Change button:
                    here is the value, here is how to change it.

                    The uppercase "Project Folder" eyebrow was also a K1 section
                    label doing a row title's job — the same violation K2 already
                    retired at Skip Permissions and Close-session prompt. */}
                <SettingRow
                  variant="item"
                  title="Project folder"
                  // The path lives in the description, not the `value` slot: a
                  // filesystem path is long and must wrap, and `value` is
                  // shrink-0 so it would push the buttons off the row.
                  description={defaults.projectFolder || 'Home directory (default)'}
                  control={
                    <div className="flex items-center gap-1 shrink-0">
                      {defaults.projectFolder && (
                        <Button variant="ghost" size="sm" onClick={() => onDefaultsChange({ projectFolder: '' })}>
                          Reset
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={handleBrowseFolder}>
                        Change
                      </Button>
                    </div>
                  }
                />

                {/* Close-session prompt — toggle off to skip the tag-before-closing
                    popup and destroy sessions immediately. Mirrors the "Don't show
                    again" checkbox inside the prompt itself. */}
                {/* K2: the other K1-label-as-row-title violation, and the one the
                    spec called out by name. "Close-session prompt" was an
                    uppercase section eyebrow labelling exactly one switch. */}
                <SettingRow
                  variant="item"
                  title="Close-session prompt"
                  description="Show tag options when closing a session"
                  control={
                    // Was a hand-rolled 32x18 track with an inline var(--accent)
                    // background; one geometry now (change 16). The state is stored
                    // INVERTED (closePromptDisabled), so `checked` is the negation —
                    // the switch reads as "show the prompt".
                    <UiToggle
                      checked={!closePromptDisabled}
                      onChange={(show) => {
                        const next = !show;
                        setClosePromptDisabled(next);
                        if (next) {
                          localStorage.setItem(CLOSE_PROMPT_SUPPRESS_KEY, '1');
                        } else {
                          localStorage.removeItem(CLOSE_PROMPT_SUPPRESS_KEY);
                        }
                      }}
                      aria-label="Close-session prompt"
                    />
                  }
                />
      </Dialog>
    </>
  );
}

// ─── Permissions (M5 item 2a) ──────────────────────────────────────────────

// Settings → Permissions: every "Always allow" a native session remembered,
// with a way to take it back. The list itself lives in PermissionsSection.tsx;
// this is only the row + the Dialog frame + the (i) explainer toggle, which is
// the same shape Remote Access, Backup & Sync and Appearance already use.
//
// NOT gated on window.claude.native.supported, unlike ModelProvidersSection
// above. remote-shim.ts hardcodes that flag false, so copying the gate would
// render nothing over remote access — the one transport where revoking a grant
// from a phone matters. Spec 2026-08-11, "Open item for Phase 1 review".
//
// No popupRef / outside-click effect here: <Dialog>'s own Scrim already calls
// onClose. The older popups in this file predate that and keep a duplicate
// handler; new ones should not grow one.
function PermissionsButton() {
  const [open, setOpen] = useState(false);
  // Flips the dialog body to the plain-language explainer. Reset on every
  // re-open so the user always lands on the list, not on whichever view they
  // happened to leave behind (same reason RemoteButton resets its showInfo).
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    if (!open) setShowInfo(false);
  }, [open]);

  return (
    <>
      <SettingRow
        icon={
          // Shield + check: an approval you granted, not a lock you're behind.
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6l7-3z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        }
        title="Permissions"
        description="Things you approved with “Always allow”"
        onClick={() => setOpen(true)}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={showInfo ? 'About Permissions' : 'Permissions'}
        onBack={showInfo ? () => setShowInfo(false) : undefined}
        headerActions={showInfo ? undefined : <InfoIconButton onClick={() => setShowInfo(true)} />}
        size="panel"
        fill
      >
        {showInfo ? (
          <SettingsExplainer
            intro={PERMISSIONS_EXPLAINER_INTRO}
            sections={PERMISSIONS_EXPLAINER_SECTIONS}
          />
        ) : (
          <PermissionsSection />
        )}
      </Dialog>
    </>
  );
}

// Settings → Specialists (1c): the two model tiers helpers run on, and the
// roster of everything the assistant can hire (built-in, your folder, the
// project's folder, Claude Code agent files) with any loader warnings. Same
// row + Dialog + (i) shape as Permissions directly above it. Not gated on
// native.supported for the same reason Permissions isn't.
function SpecialistsButton({ cwd }: { cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  useEffect(() => { if (!open) setShowInfo(false); }, [open]);
  return (
    <>
      <SettingRow
        icon={
          // Two people, one slightly behind: helpers.
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
            <path d="M16 5.5a3 3 0 0 1 0 5.6" />
            <path d="M17.5 14.5c2 .6 3.5 2.4 3.5 4.5" />
          </svg>
        }
        title="Specialists"
        description="Helpers your assistant can hire, and the models they run on"
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={showInfo ? 'About Specialists' : 'Specialists'}
        onBack={showInfo ? () => setShowInfo(false) : undefined}
        headerActions={showInfo ? undefined : <InfoIconButton onClick={() => setShowInfo(true)} />}
        size="panel"
        fill
      >
        {showInfo ? (
          <SettingsExplainer intro={SPECIALISTS_EXPLAINER_INTRO} sections={SPECIALISTS_EXPLAINER_SECTIONS} />
        ) : (
          <SpecialistsSection cwd={cwd} />
        )}
      </Dialog>
    </>
  );
}

// ─── Tier selector popup ───────────────────────────────────────────────────

// Mirrors PackageTier.kt — descriptions list the actual packages each tier
// installs, matching the native first-run TierPickerScreen labels.
const TIER_OPTIONS = [
  { id: 'CORE', name: 'Core', desc: 'Everything needed for basic Claude Code functionality' },
  { id: 'DEVELOPER', name: 'Developer Essentials', desc: 'fd, fzf, jq, bat, tmux, nano, micro' },
  { id: 'FULL_DEV', name: 'Full Dev Environment', desc: 'neovim, vim, make, cmake, sqlite' },
];

function TierSelector({ tier, onSetTier }: { tier: string; onSetTier: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const currentTier = TIER_OPTIONS.find(t => t.id === tier) || TIER_OPTIONS[0];

  return (
    <>
      {/* Current tier row — title is the static "Package Tier" label, subtitle
          is the current tier's name (was reversed: the tier name used to be
          the title with no static label, the one anti-pattern this component
          shared with pre-redesign Appearance/Remote Access/Buddy Floater). */}
      <SettingRow
        icon={<span className="text-sm leading-none text-fg-dim">⬡</span>}
        title="Package Tier"
        description={currentTier.name}
        onClick={() => setOpen(true)}
      />

      {/* Popup overlay — portaled to document.body so position:fixed centers
          against the viewport, not the SettingsPanel drawer. The drawer (and
          its glass ancestors) establishes a containing block for fixed children
          via transform/backdrop-filter, which is why an inline-rendered popup
          ends up centered inside the panel instead of the viewport. ThemeButton
          above uses the same portal pattern for the same reason. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Package Tier"
        size="prompt"
        panelRef={popupRef}
      >
              {TIER_OPTIONS.map(t => {
                const isActive = tier === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => { onSetTier(t.id); setOpen(false); }}
                    className={`w-full flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                      isActive ? 'border-accent bg-accent/10' : 'border-edge-dim hover:border-edge'
                    }`}
                  >
                    <span className={`text-sm shrink-0 mt-0.5 ${isActive ? 'text-accent' : 'text-fg-faint'}`}>
                      {isActive ? '●' : '○'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${isActive ? 'text-fg' : 'text-fg-2'}`}>{t.name}</span>
                        {isActive && <span className="text-4xs font-medium px-1.5 py-0.5 rounded-sm bg-accent text-on-accent">Active</span>}
                      </div>
                      <p className="text-3xs text-fg-muted mt-0.5">{t.desc}</p>
                    </div>
                  </button>
                );
              })}
      </Dialog>
    </>
  );
}

// ─── Android Settings ───────────────────────────────────────────────────────

interface PairedDevice {
  name: string;
  host: string;
  port: number;
  password: string;
}

function ConnectToDesktopButton() {
  const [open, setOpen] = useState(false);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [connectedDeviceName, setConnectedDeviceName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [formName, setFormName] = useState('Desktop');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('9900');
  const [formPassword, setFormPassword] = useState('');
  const [tailscaleStatus, setTailscaleStatus] = useState<{ connected: boolean; ip?: string } | null>(null);
  const [tailscaleLoading, setTailscaleLoading] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const claude = (window as any).claude;

  // Track connection mode
  useEffect(() => {
    import('../platform').then(({ isRemoteMode, onConnectionModeChange }) => {
      setRemoteConnected(isRemoteMode());
      const unsub = onConnectionModeChange((mode) => {
        setRemoteConnected(mode === 'remote');
      });
      return unsub;
    });
  }, []);

  // Load paired devices on mount
  useEffect(() => {
    claude.android?.getPairedDevices?.()
      .then((devices: any) => setPairedDevices(devices?.devices || devices || []))
      .catch(() => {});
  }, []);

  // Check Tailscale status when popup opens
  useEffect(() => {
    if (!open) return;
    setTailscaleLoading(true);
    setConnectError(null);
    claude.remote?.detectTailscale?.()
      .then((status: any) => setTailscaleStatus(status ?? null))
      .catch(() => setTailscaleStatus(null))
      .finally(() => setTailscaleLoading(false));
  }, [open]);

  const doConnect = useCallback(async (device: PairedDevice) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const { connectToHost } = await import('../remote-shim');
      await connectToHost(device.host, device.port, device.password);
      setConnectedDeviceName(device.name);
      setOpen(false);
    } catch (err: any) {
      setConnectError(err?.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleSaveDevice = useCallback(async () => {
    if (!formHost.trim()) return;
    const device: PairedDevice = {
      name: formName.trim() || 'Desktop',
      host: formHost.trim(),
      port: parseInt(formPort) || 9900,
      password: formPassword,
    };
    await claude.android?.savePairedDevice?.(device);
    setPairedDevices(prev => [...prev.filter(d => d.host !== device.host || d.port !== device.port), device]);
    setShowConnectForm(false);
    setFormName('Desktop');
    setFormHost('');
    setFormPort('9900');
    setFormPassword('');
    await doConnect(device);
  }, [formName, formHost, formPort, formPassword, doConnect]);

  const handleRemoveDevice = useCallback(async (device: PairedDevice) => {
    await claude.android?.removePairedDevice?.(device.host, device.port);
    setPairedDevices(prev => prev.filter(d => d.host !== device.host || d.port !== device.port));
  }, []);

  const handleDisconnect = useCallback(async () => {
    setConnecting(true);
    try {
      const { disconnectFromHost } = await import('../remote-shim');
      await disconnectFromHost();
      setConnectedDeviceName('');
    } catch (err: any) {
      setConnectError(err?.message || 'Disconnect failed');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleScanQr = useCallback(async () => {
    const result = await claude.android?.scanQr?.();
    if (result?.url) {
      try {
        const u = new URL(result.url);
        setFormHost(u.hostname);
        setFormPort(u.port || '9900');
        setShowConnectForm(true);
      } catch { /* invalid URL */ }
    }
  }, []);

  const subtitle = remoteConnected
    ? `Connected · ${connectedDeviceName || 'Desktop'}`
    : pairedDevices.length > 0
      ? `${pairedDevices.length} saved device${pairedDevices.length !== 1 ? 's' : ''}`
      : 'Not configured';

  return (
    <>
      <SettingRow
        icon={
          <div className="relative flex items-center justify-center">
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            {remoteConnected && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-400 ring-1 ring-panel" />
            )}
          </div>
        }
        title="Connect to Desktop"
        description={subtitle}
        descriptionClassName={remoteConnected ? 'text-green-400' : undefined}
        onClick={() => { setOpen(true); setShowConnectForm(false); }}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Connect to Desktop"
        size="panel"
        panelRef={popupRef}
      >

              {/* Tailscale warning */}
              {!tailscaleLoading && tailscaleStatus !== null && !tailscaleStatus.connected && (
                <Callout
                  tone="warning"
                  title={
                    // The glyph rides in the title node rather than getting its
                    // own slot: it is the ONLY callout in the app that has one,
                    // so a slot would be a prop that exists for a single caller.
                    <span className="flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      Tailscale not connected
                    </span>
                  }
                >
                  Enable Tailscale on this phone before connecting. Both devices must be on the same Tailscale network.
                </Callout>
              )}

              {/* Connected banner */}
              {remoteConnected && (
                <div className="bg-green-500/10 border border-green-500/25 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-xs text-green-400 font-medium">
                      Connected to {connectedDeviceName || 'Desktop'}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={handleDisconnect}
                    disabled={connecting}
                    className="w-full"
                  >
                    {connecting ? 'Disconnecting...' : 'Disconnect — Return to Local'}
                  </Button>
                </div>
              )}

              {/* Error */}
              {connectError && (
                // Was raw `red-500` around text that already used the destructive
                // TOKEN — the surface and its own body disagreed about which red
                // they were. Change 17 moved the app's reds onto the token so
                // theme packs can restyle them; this one survived that sweep.
                <Callout tone="danger">{connectError}</Callout>
              )}

              {/* Saved devices — always listed */}
              {pairedDevices.length > 0 && (
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Saved Devices</h3>
                  <div className="space-y-1">
                    {pairedDevices.map(device => (
                      // K6. The row was already two controls in a flex box: a
                      // borderless <button> wrapping the name so the whole thing
                      // connects, plus a bare ✕. SettingRow expresses exactly
                      // that — onClick makes the row the hit target and stops the
                      // control's click from bubbling into it, so Remove no
                      // longer risks also firing Connect.
                      <SettingRow
                        key={`${device.host}:${device.port}`}
                        variant="item"
                        title={device.name}
                        description={`${device.host}:${device.port}`}
                        descriptionClassName="text-fg-muted font-mono"
                        onClick={() => doConnect(device)}
                        disabled={connecting || remoteConnected}
                        control={
                          <Button variant="ghost" size="sm" onClick={() => handleRemoveDevice(device)}>
                            Remove
                          </Button>
                        }
                      />
                    ))}
                  </div>
                </section>
              )}

              {connecting && !remoteConnected && (
                <div className="text-center py-2">
                  <span className="text-xs text-fg-dim">Connecting...</span>
                </div>
              )}

              {/* Add new device */}
              {!remoteConnected && !connecting && (
                <section>
                  {pairedDevices.length > 0 && (
                    <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Add Device</h3>
                  )}
                  {!showConnectForm ? (
                    <div className="space-y-2">
                      {/* Both only had an active: state, so on desktop nothing
                          happened on hover at all. */}
                      <Button onClick={handleScanQr} className="w-full">
                        Scan QR Code
                      </Button>
                      <Button variant="secondary" onClick={() => setShowConnectForm(true)} className="w-full">
                        Enter Manually
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3 bg-inset/50 rounded-lg p-3">
                      {/* All four fields were the same bg-well / rounded-sm /
                          focus:border-fg-muted recipe; they're the shared FIELD surface
                          now (change 20). The Cancel + Save row below stays outside as a
                          form footer — it sits under the whole form, not beside one
                          field, so it is NOT an InputGroup. */}
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Device Name</label>
                        <TextInput
                          size="sm"
                          value={formName}
                          onChange={e => setFormName(e.target.value)}
                          placeholder="My Desktop"
                          aria-label="Device Name"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Host / IP</label>
                        <TextInput
                          size="sm"
                          value={formHost}
                          onChange={e => setFormHost(e.target.value)}
                          placeholder="100.x.x.x"
                          aria-label="Host / IP"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Port</label>
                        <TextInput
                          size="sm"
                          value={formPort}
                          onChange={e => setFormPort(e.target.value)}
                          placeholder="9900"
                          aria-label="Port"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Password</label>
                        <TextInput
                          size="sm"
                          type="password"
                          value={formPassword}
                          onChange={e => setFormPassword(e.target.value)}
                          placeholder="Remote access password"
                          aria-label="Remote access password"
                          className="w-full"
                        />
                      </div>
                      <div className="flex gap-2">
                        {/* Collapses the add-device form rather than closing the
                            panel, so it isn't a redundant text cancel. */}
                        <Button variant="secondary" onClick={() => setShowConnectForm(false)}>
                          Cancel
                        </Button>
                        <Button onClick={handleSaveDevice} disabled={!formHost.trim()} className="flex-1">
                          Save &amp; Connect
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              <p className="text-3xs text-fg-muted">
                Connect to the YouCoded desktop app on your computer. Set up remote access in the desktop app's settings first.
              </p>
      </Dialog>
    </>
  );
}

function AndroidSettings({ open, onSendInput, onRunCommand, onOpenThemeMarketplace, onPublishTheme, syncAutoOpen, onSyncAutoOpenHandled }: { open: boolean; onClose: () => void; onSendInput: (text: string) => void; onRunCommand?: (command: string) => void; onOpenThemeMarketplace?: () => void; onPublishTheme?: (slug: string) => void; syncAutoOpen?: boolean; onSyncAutoOpenHandled?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState('CORE');
  const [aboutInfo, setAboutInfo] = useState<{ version: string; build: string } | null>(null);
  const [defaults, setDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } });
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showDonateConfirm, setShowDonateConfirm] = useState(false);
  const [showDevMenu, setShowDevMenu] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showContribute, setShowContribute] = useState(false);

  const claude = (window as any).claude;

  // Sync remote connection state
  useEffect(() => {
    import('../platform').then(({ isRemoteMode, onConnectionModeChange }) => {
      setRemoteConnected(isRemoteMode());
      const unsub = onConnectionModeChange((mode) => {
        setRemoteConnected(mode === 'remote');
      });
      return unsub;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    // Fix: defer IPC calls until after the 300ms slide-in animation. Firing
    // three parallel bridge calls synchronously visibly stutters the panel.
    const _deferTimer = setTimeout(() => {
    Promise.all([
      claude.android?.getTier?.() ?? 'CORE',
      claude.android?.getAbout?.() ?? { version: 'unknown', build: '' },
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } },
    ]).then(([t, about, defs]) => {
      setTier(t?.tier || t || 'CORE');
      setAboutInfo(about);
      setDefaults(defs);
      setLoading(false);
    }).catch(() => setLoading(false));
    }, 350);
    return () => clearTimeout(_deferTimer);
  }, [open]);

  const handleSetTier = useCallback(async (newTier: string) => {
    const result = await claude.android?.setTier?.(newTier);
    setTier(newTier);
    if (result?.restartRequired) {
      // The bridge handles restart prompt natively
    }
  }, []);

  const handleDefaultsChange = useCallback(async (updates: Partial<typeof defaults>) => {
    const merged = { ...defaults, ...updates };
    setDefaults(merged);
    await claude.defaults?.set?.(updates);
  }, [defaults]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-muted text-sm">
        Loading...
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 px-4 py-4 space-y-2">

        {/* Account leads the stack — your identity is the first thing settings should show (Destin, 2026-07-08) */}
        <AccountSection />

        <ThemeButton onSendInput={onSendInput} onRunCommand={onRunCommand} onOpenMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />

        {/* No <BuddyButton /> on Android — the floater relies on an Electron always-on-top window that Android doesn't support yet */}

        <PerformanceButton />

        <SyncSection autoOpen={syncAutoOpen} onAutoOpenHandled={onSyncAutoOpenHandled} />

        {/* Tier & directories are local-only — hide when connected to remote desktop */}
        {!remoteConnected && (
          <>
            <TierSelector tier={tier} onSetTier={handleSetTier} />
          </>
        )}

        <ConnectToDesktopButton />

        <DefaultsButton defaults={defaults} onDefaultsChange={handleDefaultsChange} />

        {/* Development — bug reports, contributions, known issues */}
        <SettingRow
          icon={
            // {YC} — curly braces with YC monogram in Cascadia Mono (matches
            // the "Development" label's font size).
            <svg className="w-6 h-4 text-fg-muted" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4 C 3 4 3 7 3 9 C 3 11 2 12 1 12 C 2 12 3 13 3 15 C 3 17 3 20 5 20" />
              <path d="M27 4 C 29 4 29 7 29 9 C 29 11 30 12 31 12 C 30 12 29 13 29 15 C 29 17 29 20 27 20" />
              <text x="16" y="17" textAnchor="middle" fontFamily="'Cascadia Code', 'Cascadia Mono', Consolas, monospace" fontSize="16" fontWeight="500" fill="currentColor" stroke="none">YC</text>
            </svg>
          }
          title="Development"
          description="Report a bug, contribute, or browse known issues"
          onClick={() => setShowDevMenu(true)}
        />
        <DevelopmentPopup
          open={showDevMenu}
          onClose={() => setShowDevMenu(false)}
          onOpenBug={() => { setShowDevMenu(false); setShowBugReport(true); }}
          onOpenContribute={() => { setShowDevMenu(false); setShowContribute(true); }}
        />
        <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
        <ContributePopup open={showContribute} onClose={() => setShowContribute(false)} />

        {/* Keyboard shortcuts intentionally omitted on Android — no physical keyboard. */}

        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
            </svg>
          }
          title="Donate"
          description="Support YouCoded development"
          onClick={() => setShowDonateConfirm(true)}
        />

        <DonateConfirm open={showDonateConfirm} onClose={() => setShowDonateConfirm(false)} />

        {aboutInfo && (
          <>
            <SettingRow
              icon={
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              }
              title="About"
              description={formatVersionLine({ version: aboutInfo.version, build: aboutInfo.build })}
              onClick={() => setShowAbout(true)}
            />
            <AboutPopup
              open={showAbout}
              onClose={() => setShowAbout(false)}
              platform="android"
              version={aboutInfo.version}
              build={aboutInfo.build}
            />
          </>
        )}
      </div>
    </>
  );
}

// ─── Desktop Settings (existing, unchanged) ─────────────────────────────────

function DesktopSettings({ open, onSendInput, onRunCommand, hasActiveSession, activeSessionCwd, onOpenThemeMarketplace, onPublishTheme, onOpenClaudePreferences, syncAutoOpen, onSyncAutoOpenHandled, providersAutoOpen, onProvidersAutoOpenHandled }: {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  onRunCommand?: (command: string) => void;
  hasActiveSession: boolean;
  // Task 10: threaded to SpecialistsButton → SpecialistsSection.
  activeSessionCwd?: string;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  // Opens Claude Code's preferences popup (/config). Consumed by the Model
  // Providers popup's Claude Code section. Desktop-only.
  onOpenClaudePreferences?: () => void;
  syncAutoOpen?: boolean;
  onSyncAutoOpenHandled?: () => void;
  // Deep-link the Model Providers popup open (provider-error bubble jump).
  providersAutoOpen?: boolean;
  onProvidersAutoOpenHandled?: () => void;
}) {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loading, setLoading] = useState(true);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showSetupQR, setShowSetupQR] = useState(false);
  const [copied, setCopied] = useState(false);
  const [defaults, setDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } });
  const [setupStatus, setSetupStatus] = useState<'idle' | 'confirm' | 'installing' | 'authenticating' | 'done' | 'error'>('idle');
  const [setupError, setSetupError] = useState('');
  // Populated when IPC.REMOTE_SET_CONFIG reports the server failed to bind.
  const [enableError, setEnableError] = useState('');
  const [showDonateConfirm, setShowDonateConfirm] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showDevMenu, setShowDevMenu] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showContribute, setShowContribute] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setShowAddDevice(false);
    setShowSetupQR(false);
    const claude = (window as any).claude;
    if (!claude?.remote) { setLoading(false); return; }
    // Fix: defer IPC calls until after the 300ms slide-in animation. detectTailscale
    // in particular blocks the main thread long enough to visibly stutter the panel.
    const _deferTimer = setTimeout(() => {
    Promise.all([
      claude.remote.getConfig(),
      claude.remote.detectTailscale(),
      claude.remote.getClientList(),
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } },
    ]).then(([cfg, ts, cls, defs]: [RemoteConfig, TailscaleInfo, ClientInfo[], any]) => {
      setConfig(cfg);
      setTailscale(ts);
      setClients(cls);
      setDefaults(defs);
      setLoading(false);
    }).catch(() => setLoading(false));
    }, 350);
    return () => clearTimeout(_deferTimer);
  }, [open]);

  const handleSetPassword = useCallback(async () => {
    if (!newPassword.trim()) return;
    setPasswordStatus('saving');
    try {
      await (window as any).claude.remote.setPassword(newPassword);
      setConfig(prev => prev ? { ...prev, hasPassword: true } : prev);
      setNewPassword('');
      setPasswordStatus('saved');
      setTimeout(() => setPasswordStatus('idle'), 2000);
    } catch {
      setPasswordStatus('idle');
    }
  }, [newPassword]);

  const handleToggleEnabled = useCallback(async () => {
    if (!config) return;
    setEnableError('');
    const updated = await (window as any).claude.remote.setConfig({ enabled: !config.enabled });
    // Main rolls `enabled` back to false when the server can't bind and returns
    // the OS error; spreading `updated` therefore also un-sticks the toggle.
    if (updated?.error) setEnableError(String(updated.error));
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, [config]);

  const handleToggleTailscaleTrust = useCallback(async () => {
    if (!config) return;
    const updated = await (window as any).claude.remote.setConfig({ trustTailscale: !config.trustTailscale });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, [config]);

  const handleSetKeepAwake = useCallback(async (hours: number) => {
    const updated = await (window as any).claude.remote.setConfig({ keepAwakeHours: hours });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, []);

  const handleRunSetup = useCallback(() => {
    setSetupStatus('confirm');
    setSetupError('');
  }, []);

  const handleCancelSetup = useCallback(() => {
    setSetupStatus('idle');
    setSetupError('');
  }, []);

  const handleConfirmSetup = useCallback(async () => {
    try {
      // Check if already installed before trying to install
      const check = await (window as any).claude.remote.detectTailscale();
      if (check?.installed) {
        // Already installed — skip to auth
        setSetupStatus('authenticating');
        await (window as any).claude.remote.authTailscale();
        setSetupStatus('done');
        setTailscale(check);
        setTimeout(() => setSetupStatus('idle'), 3000);
        return;
      }

      setSetupStatus('installing');
      const result = await (window as any).claude.remote.installTailscale();
      if (result?.success) {
        setSetupStatus('authenticating');
        await (window as any).claude.remote.authTailscale();
        setSetupStatus('done');
        const ts = await (window as any).claude.remote.detectTailscale();
        setTailscale(ts);
        setTimeout(() => setSetupStatus('idle'), 3000);
      } else {
        setSetupError(result?.error || 'Installation failed');
        setSetupStatus('error');
      }
    } catch (err) {
      setSetupError(String(err));
      setSetupStatus('error');
    }
  }, []);

  const handleDisconnectClient = useCallback(async (clientId: string) => {
    await (window as any).claude.remote.disconnectClient(clientId);
    setClients(prev => prev.filter(c => c.id !== clientId));
    setConfig(prev => prev ? { ...prev, clientCount: Math.max(0, prev.clientCount - 1) } : prev);
  }, []);

  const handleCopyLink = useCallback(() => {
    if (tailscale?.url) {
      navigator.clipboard.writeText(tailscale.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [tailscale]);

  const handleDefaultsChange = useCallback(async (updates: Partial<typeof defaults>) => {
    const merged = { ...defaults, ...updates };
    setDefaults(merged);
    await (window as any).claude.defaults?.set?.(updates);
  }, [defaults]);

  return (
    <>
      <div className="flex-1 px-4 py-4 space-y-2">

        {/* Account leads the stack — your identity is the first thing settings should show (Destin, 2026-07-08).
            GitHub (and future providers) live INSIDE it on the Connected
            accounts page — a sibling GitHub row read as a second, contradictory
            sign-in (Destin feedback, 2026-07-22). */}
        <AccountSection />

        <ThemeButton onSendInput={onSendInput} onRunCommand={onRunCommand} onOpenMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />

        <BuddyButton />

        <SoundButton />

        <PerformanceButton />

        <SyncSection autoOpen={syncAutoOpen} onAutoOpenHandled={onSyncAutoOpenHandled} />

        {/* Model Providers — one popup gathering Claude Code, OpenRouter, and
            Local Models (the Plan A/B/C native-runtime surfaces). Self-gated on
            native.supported, so it renders nothing in production until Phase 2.
            Desktop-authoritative — NOT mounted in AndroidSettings. */}
        <ModelProvidersSection
          onOpenClaudePreferences={onOpenClaudePreferences}
          autoOpen={providersAutoOpen}
          onAutoOpenHandled={onProvidersAutoOpenHandled}
        />

        <RemoteButton
          config={config}
          tailscale={tailscale}
          clients={clients}
          loading={loading}
          hasActiveSession={hasActiveSession}
          newPassword={newPassword}
          passwordStatus={passwordStatus}
          copied={copied}
          showSetupQR={showSetupQR}
          showAddDevice={showAddDevice}
          onSetNewPassword={setNewPassword}
          onSetPassword={handleSetPassword}
          onToggleEnabled={handleToggleEnabled}
          enableError={enableError}
          onToggleTailscaleTrust={handleToggleTailscaleTrust}
          onSetKeepAwake={handleSetKeepAwake}
          onRunSetup={handleRunSetup}
          onConfirmSetup={handleConfirmSetup}
          onCancelSetup={handleCancelSetup}
          setupStatus={setupStatus}
          setupError={setupError}
          onDisconnectClient={handleDisconnectClient}
          onCopyLink={handleCopyLink}
          onSetShowSetupQR={setShowSetupQR}
          onSetShowAddDevice={setShowAddDevice}
          onReportIssue={() => setShowBugReport(true)}
        />

        <DefaultsButton defaults={defaults} onDefaultsChange={handleDefaultsChange} />

        {/* Permissions sits directly under Defaults because they are the two
            halves of the same question: Defaults sets how much a NEW session
            asks, Permissions lists the individual asks you already waived.
            Desktop-authoritative — NOT mounted in AndroidSettings, whose
            runtime stubs the permissions:* channels (M8 owns Android parity).
            A phone reaching this over remote access reports platform 'browser',
            so it renders DesktopSettings and still gets the screen. */}
        <PermissionsButton />

        {/* Specialists (1c) sits under Permissions: approving a hire is a
            permission grant, and this is where its two model tiers and the
            roster live. */}
        <SpecialistsButton cwd={activeSessionCwd} />

        {/* Development — bug reports, contributions, known issues */}
        <SettingRow
          icon={
            // {YC} — curly braces with YC monogram in Cascadia Mono (matches
            // the "Development" label's font size).
            <svg className="w-6 h-4 text-fg-muted" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4 C 3 4 3 7 3 9 C 3 11 2 12 1 12 C 2 12 3 13 3 15 C 3 17 3 20 5 20" />
              <path d="M27 4 C 29 4 29 7 29 9 C 29 11 30 12 31 12 C 30 12 29 13 29 15 C 29 17 29 20 27 20" />
              <text x="16" y="17" textAnchor="middle" fontFamily="'Cascadia Code', 'Cascadia Mono', Consolas, monospace" fontSize="16" fontWeight="500" fill="currentColor" stroke="none">YC</text>
            </svg>
          }
          title="Development"
          description="Report a bug, contribute, or browse known issues"
          onClick={() => setShowDevMenu(true)}
        />
        <DevelopmentPopup
          open={showDevMenu}
          onClose={() => setShowDevMenu(false)}
          onOpenBug={() => { setShowDevMenu(false); setShowBugReport(true); }}
          onOpenContribute={() => { setShowDevMenu(false); setShowContribute(true); }}
        />
        <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
        <ContributePopup open={showContribute} onClose={() => setShowContribute(false)} />

        {/* Keyboard Shortcuts */}
        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8" />
            </svg>
          }
          title="Keyboard Shortcuts"
          description="View all hotkeys"
          onClick={() => setShowShortcuts(true)}
        />
        <ShortcutsPopup open={showShortcuts} onClose={() => setShowShortcuts(false)} />

        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
            </svg>
          }
          title="Donate"
          description="Support YouCoded development"
          onClick={() => setShowDonateConfirm(true)}
        />

        <DonateConfirm open={showDonateConfirm} onClose={() => setShowDonateConfirm(false)} />

        {/* About — popup on click, styled like other settings popups */}
        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          }
          title="About"
          description={formatVersionLine({ version: desktopVersion, channel: desktopChannel })}
          onClick={() => setShowAbout(true)}
        />
        <AboutPopup
          open={showAbout}
          onClose={() => setShowAbout(false)}
          platform="desktop"
          version={desktopVersion}
          channel={desktopChannel}
        />
      </div>
    </>
  );
}

