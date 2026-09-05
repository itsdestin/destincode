// Voice prompting — the microphone itself, DESKTOP ONLY.
//
// Two jobs, and nothing else:
//   probe()  — "could this computer listen at all?" (is there a microphone
//              plugged in, and has the operating system allowed us to use it)
//   open()   — actually opens the microphone and hands back 100 ms slices of
//              sound, plus how loud each slice was.
//
// Nothing in this file knows about React, the composer, or the speech engine.
// It runs in a browser tab and in an Android WebView, so there are no Node
// APIs here — only what a web page has.
//
// Design: docs/active/specs/2026-09-05-voice-prompting-technical-design.md
// ("Renderer"). Contract rows R11, R14.

/** What the operating system says about microphone permission (the bridge's answer). */
export type MicAccess = 'granted' | 'denied' | 'not-determined' | 'unknown';

export interface MicProbe {
  /** Whether this computer reports ANY audio input device. */
  hasAudioInput: boolean;
  /** What the operating system says about permission for this app. */
  access: MicAccess;
}

/** An open microphone. `close()` is safe to call twice. */
export interface CaptureHandle {
  close: () => void;
}

/** One 100 ms slice of sound: the raw samples, and how loud that slice was (0..1). */
export type ChunkHandler = (chunk: ArrayBuffer, rms: number) => void;

// The audio worklet's source code, as text.
//
// WHY it is a string and not a file: an AudioWorklet runs in its own tiny world
// with no `window`, so it cannot talk to the app's bridge itself — it can only
// post messages back. It also has to be loaded from a URL, and working out what
// that URL is inside a PACKAGED Electron app (asar, file://, build chunk names)
// is a whole class of "works in dev, 404s in the installed app" bugs. Building
// the module here and handing the browser a Blob URL sidesteps every one of
// them: the code ships inside this file, and the URL is made at runtime.
//
// What the processor does: it fills a bucket with samples until the bucket holds
// exactly a tenth of a second, works out the loudness of that tenth of a second
// while it fills, and posts both in ONE message. One message, not two, because
// the loudness has to reach the main process alongside its own audio — that is
// what decides "the user stopped talking two seconds ago, close the mic".
const WORKLET_SOURCE = `
class YouCodedVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // A tenth of a second's worth of samples. Derived from the REAL sample rate
    // rather than hardcoded at 1600, because a browser is allowed to ignore the
    // 16 kHz hint the page asked for — if it does, we still want 100 ms slices
    // rather than slices of the wrong length.
    this.size = Math.round(sampleRate / 10);
    this.buf = new Int16Array(this.size);
    this.n = 0;
    this.energy = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // No input yet (the microphone is still warming up) — stay alive and wait.
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      let s = ch[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.energy += s * s;
      // -1..1 becomes a whole number the speech engine understands. The two
      // limits are not symmetrical, which is why the sign is checked.
      this.buf[this.n] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.n += 1;
      if (this.n === this.size) {
        const rms = Math.sqrt(this.energy / this.size);
        const out = this.buf.buffer;
        // The buffer is TRANSFERRED, not copied — it stops belonging to the
        // worklet the moment it is posted, so a fresh one is made below.
        this.port.postMessage({ chunk: out, rms }, [out]);
        this.buf = new Int16Array(this.size);
        this.n = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}
registerProcessor('youcoded-voice-capture', YouCodedVoiceCapture);
`;

const PROCESSOR_NAME = 'youcoded-voice-capture';

/** How loud the microphone sounds, as a 0..1 number the little meter can use.
 *
 *  WHY the raw loudness is not good enough for the meter: a person talking
 *  normally measures about 0.05 on the raw scale, and the meter's bars only
 *  start lighting at 0.15 — so a raw number would leave the ring looking dead
 *  while someone is speaking perfectly clearly. Sound is heard on a multiplying
 *  scale, not a straight one, so this converts to decibels and stretches the
 *  range a human voice actually lives in (a quiet room to a loud sentence)
 *  across the whole meter.
 *
 *  The UNTOUCHED number is what goes to the main process, because the "you have
 *  stopped talking" rule is tuned against real loudness, not against a number
 *  bent to look good on screen. */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const t = (db + 60) / 50; // -60 dB (near silence) → 0, -10 dB (loud) → 1
  return Math.max(0, Math.min(1, t));
}

/** Ask this computer two questions: is there a microphone, and are we allowed to use it?
 *
 *  `micAccess` is the bridge's own member — it is passed in rather than reached
 *  for, so this file never has to know what a bridge is. */
export async function probe(micAccess: () => Promise<MicAccess>): Promise<MicProbe> {
  let hasAudioInput = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    hasAudioInput = devices.some((d) => d.kind === 'audioinput');
  } catch {
    // WHY this stays TRUE when the question could not be asked: the only thing
    // this flag is used for is to tell the user "No microphone was found on
    // this computer." Saying that because the LOOKUP failed would be telling
    // him something we did not actually find out — the exact kind of confident
    // wrong answer docs/error-message-standards.md forbids. Unknown falls
    // through to the general message instead, which names the real error.
    hasAudioInput = true;
  }
  let access: MicAccess = 'unknown';
  try {
    access = await micAccess();
  } catch {
    access = 'unknown';
  }
  return { hasAudioInput, access };
}

/** Open the microphone. Resolves once sound is genuinely flowing; rejects with
 *  the browser's own error (its `name` is what tells "refused" from "none
 *  plugged in") if it is not. */
export async function open(onChunk: ChunkHandler): Promise<CaptureHandle> {
  // echoCancellation/noiseSuppression/autoGainControl are the browser's own
  // clean-up: they stop the app's own speaker feeding back into the mic, damp
  // room hiss, and even out someone sitting far from a laptop.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  let ctx: AudioContext | undefined;
  let url: string | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    // Order matters only in that the microphone light must go off: stop the
    // hardware tracks first, then let go of everything else.
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    if (node) { node.port.onmessage = null; try { node.disconnect(); } catch { /* already gone */ } }
    try { source?.disconnect(); } catch { /* already gone */ }
    try { sink?.disconnect(); } catch { /* already gone */ }
    try { void ctx?.close(); } catch { /* already gone */ }
    if (url) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
  };

  try {
    // 16 kHz is what the speech engine wants. Chromium accepts a 48 kHz
    // microphone into a 16 kHz context and converts on the way in, so this is a
    // convenience rather than something that has to hold — the worklet above
    // works out its slice length from whatever rate it actually gets.
    ctx = new AudioContext({ sampleRate: 16000 });
    url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    url = undefined;

    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME);
    node.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { chunk: ArrayBuffer; rms: number } | undefined;
      if (!data || !data.chunk) return;
      onChunk(data.chunk, data.rms);
    };

    // WHY the silent gain node: a browser only runs the parts of an audio graph
    // that lead somewhere. A worklet wired to nothing can simply never be asked
    // to run, and the microphone would sit open producing nothing at all. This
    // gives it somewhere to lead, at zero volume, so nothing is ever heard.
    sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    // A context can start suspended (a page that has not been interacted with).
    if (ctx.state === 'suspended') await ctx.resume();
  } catch (err) {
    // Anything that went wrong AFTER the microphone opened still has to hand
    // the hardware back, or the recording light stays on with nothing behind it.
    close();
    throw err;
  }

  return { close };
}
