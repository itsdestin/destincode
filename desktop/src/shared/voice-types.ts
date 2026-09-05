// Voice prompting — the contract every surface of `window.claude.voice` agrees on
// (desktop preload, remote-shim, Android SessionService, and the workbench fake).
//
// Decided on the 2026-09-05 questions deck (docs/active/design/2026-09-05-voice-prompting/):
// words appear while you talk (Q-2), the mic is tap-to-start with a silence
// stop (Q-3), the text waits in the box (Q-4), the first tap offers the one-time
// download (Q-5), Android uses the phone's own recogniser (Q-6). The engine is
// Parakeet TDT 0.6B v3 through sherpa-onnx (Destin, after the bench:
// docs/active/investigations/2026-09-05-local-speech-engines.md).

/** Whether the mic can listen right now, and if not, what stands in the way. */
export type VoiceReadiness =
  | { state: 'ready'; engine: string }
  /** The speech model is not on this computer yet. `sizeMb` is what the first-run card prints. */
  | { state: 'needs-download'; engine: string; sizeMb: number }
  | { state: 'downloading'; engine: string; sizeMb: number; percent: number }
  /** A SPECIFIC reason (no microphone, permission denied, unsupported platform) —
   *  never a guess, per docs/error-message-standards.md. */
  | { state: 'unavailable'; reason: string };

/** Pushed by the host while the mic is open (and for readiness changes at any time). */
export type VoiceEvent =
  | { type: 'readiness'; readiness: VoiceReadiness }
  /** Microphone loudness 0..1, several times a second — drives the little meter. */
  | { type: 'level'; value: number }
  /** Live words. `committed` will not change again; `tail` is the last pass's
   *  newest words and may still be rewritten (rendered grey in the composer). */
  | { type: 'partial'; committed: string; tail: string }
  /** The mic closed (tap, silence, or stop) and this is the whole utterance. */
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

export interface VoiceBridge {
  status: () => Promise<VoiceReadiness>;
  /** Fetch the speech model; progress arrives as `readiness` events. */
  download: () => Promise<void>;
  start: () => Promise<void>;
  /** Close the mic and deliver `final`. */
  stop: () => Promise<void>;
  /** Close the mic and discard everything heard. */
  cancel: () => Promise<void>;
  onEvent: (cb: (e: VoiceEvent) => void) => () => void;
}
