// Voice prompting — the composer's view of `window.claude.voice`.
//
// One hook owns the mic's phase (idle → listening → finishing → idle), the
// readiness the host reports (ready / needs-download / downloading /
// unavailable), the loudness meter and the elapsed seconds. Live words are
// handed straight to the caller through `onPartial` / `onFinal` so the input
// bar can merge them into its own draft — the hook never holds text itself,
// which is what keeps "what is in the box" a single source of truth.
//
// `supported` is false when the host exposes no `voice` namespace at all
// (older desktop builds, the remote browser client — deck Q-7 keeps the mic off
// it until remote access is encrypted). The input bar then renders no mic.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceEvent, VoiceReadiness } from '../../shared/voice-types';

export type VoicePhase = 'idle' | 'listening' | 'finishing';

interface Options {
  onPartial: (committed: string, tail: string) => void;
  onFinal: (text: string) => void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useVoiceInput({ onPartial, onFinal }: Options) {
  // Captured ONCE at mount, not read every render: the workbench's compare
  // panes mount three composers against three different fakes in one page,
  // and each must keep the bridge it was born with.
  const [bridge] = useState(() => (typeof window !== 'undefined' ? window.claude?.voice : undefined));
  const [readiness, setReadiness] = useState<VoiceReadiness | null>(null);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Callbacks and phase live in refs so the single onEvent subscription below
  // never has to be torn down and re-made as the input bar re-renders.
  const cbRef = useRef({ onPartial, onFinal });
  cbRef.current = { onPartial, onFinal };
  const phaseRef = useRef<VoicePhase>('idle');
  const setPhaseBoth = useCallback((p: VoicePhase) => { phaseRef.current = p; setPhase(p); }, []);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.status().then((r) => { if (live) setReadiness(r); }).catch((err) => { if (live) setError(describe(err)); });
    const off = bridge.onEvent((e: VoiceEvent) => {
      switch (e.type) {
        case 'readiness': setReadiness(e.readiness); break;
        case 'level': setLevel(e.value); break;
        case 'partial': cbRef.current.onPartial(e.committed, e.tail); break;
        case 'final':
          setPhaseBoth('idle'); setLevel(0);
          cbRef.current.onFinal(e.text);
          break;
        case 'error':
          setPhaseBoth('idle'); setLevel(0);
          setError(e.message);
          break;
      }
    });
    return () => { live = false; off(); };
  }, [bridge, setPhaseBoth]);

  // Elapsed time while listening — the one number that tells you the mic is
  // still open when you have paused to think.
  useEffect(() => {
    if (phase !== 'listening') { setSeconds(0); return; }
    const t0 = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const start = useCallback(async () => {
    if (!bridge || phaseRef.current !== 'idle') return;
    setError(null);
    setPhaseBoth('listening');
    try { await bridge.start(); } catch (err) { setPhaseBoth('idle'); setError(describe(err)); }
  }, [bridge, setPhaseBoth]);

  const stop = useCallback(async () => {
    if (!bridge || phaseRef.current !== 'listening') return;
    setPhaseBoth('finishing');
    try { await bridge.stop(); } catch (err) { setPhaseBoth('idle'); setError(describe(err)); }
  }, [bridge, setPhaseBoth]);

  const cancel = useCallback(async () => {
    if (!bridge || phaseRef.current === 'idle') return;
    setPhaseBoth('idle'); setLevel(0);
    try { await bridge.cancel(); } catch (err) { setError(describe(err)); }
  }, [bridge, setPhaseBoth]);

  const download = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try { await bridge.download(); } catch (err) { setError(describe(err)); }
  }, [bridge]);

  const recheck = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try { setReadiness(await bridge.status()); } catch (err) { setError(describe(err)); }
  }, [bridge]);

  const clearError = useCallback(() => setError(null), []);

  return { supported: !!bridge, readiness, phase, level, seconds, error, start, stop, cancel, download, recheck, clearError };
}
