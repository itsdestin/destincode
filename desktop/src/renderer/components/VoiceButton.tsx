// Voice prompting — the mic in the composer, and the small card behind it.
//
// Four looks, one button (deck 2026-09-05, docs/active/design/2026-09-05-voice-prompting/):
//   idle       a ghost icon like Attach and Skills — tap to talk
//   listening  the button fills with accent and breathes a ring (globals.css
//              `.voice-mic-on`); a four-bar loudness meter and the elapsed time
//              sit to its left so you know it is still hearing you (Q-3: "an
//              obvious glowing state and a Stop are essential")
//   finishing  a spinner for the beat between the mic closing and the last
//              words settling
//   card       when the engine is not ready the tap opens a card ABOVE the mic:
//              first run offers the one-time download and says the voice never
//              leaves this computer (Q-5); while downloading it shows progress;
//              when the computer has no microphone it says exactly that.
//
// The card is positioned the way AnchorTip positions its bubble — a portaled
// OverlayPanel at layer 4, measured from the trigger — rather than reusing
// AnchorTip, whose trigger is its own ⓘ glyph. Overlay.tsx stays the only
// z-index authority.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/Button';
import { ProgressBar } from './ui/ProgressBar';
import { OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { MicIcon } from './Icons';
import type { VoiceReadiness } from '../../shared/voice-types';
import type { VoicePhase } from '../hooks/useVoiceInput';

interface Props {
  phase: VoicePhase;
  readiness: VoiceReadiness | null;
  level: number;
  seconds: number;
  error: string | null;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
  onDownload: () => void;
  onRecheck: () => void;
  onClearError: () => void;
  /** Fired once when a download completes — the input bar toasts "Voice is ready". */
  onReady?: () => void;
}

/** Four bars whose height follows the microphone level, plus m:ss elapsed. */
function VoiceMeter({ level, seconds }: { level: number; seconds: number }) {
  // Each bar wakes up at a higher level so quiet speech still moves the first
  // one and only a loud moment lights all four.
  const heights = [0.15, 0.35, 0.6, 0.85].map((gate) => {
    const t = Math.max(0, Math.min(1, (level - gate * 0.6) / 0.5));
    return 4 + Math.round(t * 10);
  });
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <span className="flex items-center gap-1.5 text-2xs text-fg-muted tabular-nums select-none" aria-live="off">
      <span className="flex items-end gap-0.5 h-3.5" aria-hidden="true">
        {heights.map((h, i) => (
          <span key={i} className="voice-bar w-0.5 rounded-full bg-accent" style={{ height: `${h}px` }} />
        ))}
      </span>
      <span>{mm}:{ss}</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  );
}

export function VoiceButton({ phase, readiness, level, seconds, error, disabled, onStart, onStop, onDownload, onRecheck, onClearError, onReady }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasDownloading = useRef(false);

  const listening = phase === 'listening';
  const state = readiness?.state ?? 'unavailable';

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The mic lives at the composer's right edge, so a card centred on it would
    // run off the window. Hang the card's RIGHT edge from the mic's right edge
    // instead (translate(-100%, -100%) below): it grows leftward, over the box.
    setPos({ x: r.right, y: r.top - 8 });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  useEscClose(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // The download finished: close the card and let the input bar say so.
  useEffect(() => {
    if (state === 'downloading') wasDownloading.current = true;
    if (state === 'ready' && wasDownloading.current) {
      wasDownloading.current = false;
      setOpen(false);
      onReady?.();
    }
  }, [state, onReady]);

  // An error while listening opens the card so the message is read, not lost.
  useEffect(() => { if (error) setOpen(true); }, [error]);

  const handleClick = () => {
    if (error) { setOpen((v) => !v); return; }
    if (state === 'ready') {
      if (listening) onStop(); else onStart();
      return;
    }
    setOpen((v) => !v);
  };

  const label = error ? 'Voice stopped — see why'
    : listening ? 'Stop listening'
    : phase === 'finishing' ? 'Finishing…'
    : state === 'ready' ? 'Speak your message'
    : state === 'downloading' ? 'Voice is downloading'
    : state === 'needs-download' ? 'Speak your message (one-time download)'
    : "Voice isn't available";

  let card: React.ReactNode = null;
  if (error) {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Voice stopped</p>
        <p className="text-2xs text-fg-2 leading-snug">{error}</p>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={() => { onClearError(); setOpen(false); }}>OK</Button>
        </div>
      </>
    );
  } else if (state === 'needs-download' && readiness?.state === 'needs-download') {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Speak your messages</p>
        <p className="text-2xs text-fg-2 leading-snug">
          Tap the mic, talk, and your words appear here with punctuation, ready to fix or send.
          Your voice is turned into text on this computer and never leaves it.
        </p>
        <p className="text-2xs text-fg-muted mt-2">One-time download: {readiness.sizeMb} MB.</p>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Not now</Button>
          <Button variant="primary" size="sm" onClick={onDownload}>Download</Button>
        </div>
      </>
    );
  } else if (state === 'downloading' && readiness?.state === 'downloading') {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Getting voice ready</p>
        <ProgressBar percent={readiness.percent} showLabel aria-label="Voice download" />
        <p className="text-2xs text-fg-muted mt-2">{readiness.sizeMb} MB, once. You can keep typing; the mic wakes up when it is done.</p>
      </>
    );
  } else if (state === 'unavailable') {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Voice isn&rsquo;t available</p>
        <p className="text-2xs text-fg-2 leading-snug">{readiness?.state === 'unavailable' ? readiness.reason : 'Still checking whether this computer can listen.'}</p>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={onRecheck}>Check again</Button>
        </div>
      </>
    );
  }

  return (
    <div className="relative shrink-0 flex items-center gap-2">
      {listening && <VoiceMeter level={level} seconds={seconds} />}
      <Button
        ref={triggerRef}
        type="button"
        variant={listening ? 'primary' : 'ghost'}
        size="icon"
        aria-label={label}
        aria-pressed={listening}
        aria-expanded={open || undefined}
        title={label}
        disabled={disabled || phase === 'finishing'}
        onClick={handleClick}
        className={`rounded-full ${listening ? 'voice-mic-on' : ''}`}
      >
        {phase === 'finishing' ? <Spinner /> : <MicIcon className="w-4 h-4" />}
      </Button>
      {open && card &&
        createPortal(
          <OverlayPanel
            ref={panelRef}
            layer={4}
            role="dialog"
            aria-label="Voice"
            className="fixed p-3 text-left w-72 max-w-[calc(100vw-1.5rem)]"
            style={{ left: pos.x, top: pos.y, transform: 'translate(-100%, -100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {card}
          </OverlayPanel>,
          document.body,
        )}
    </div>
  );
}

