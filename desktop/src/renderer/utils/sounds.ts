/**
 * Sound engine — synthesized + custom notification sounds via Web Audio API.
 *
 * Two sound categories, each with selectable presets (shared stock list)
 * plus optional custom sound files:
 * - attention: played when a session turns red (awaiting approval)
 * - ready:     played when any session finishes thinking (response complete)
 *
 * Custom sound format support: Chromium's decodeAudioData handles mp3, wav,
 * ogg, opus, flac, aac, m4a, webm natively. AIFF is NOT in Chromium's codec
 * set, so parseAiffToAudioBuffer() below decodes it in pure JS — this is what
 * makes Apple's /System/Library/Sounds/*.aiff files work on macOS.
 */

// ── Storage keys ─────────────────────────────────────────────────────────────

export const SOUND_MUTED_KEY     = 'youcoded-sound-muted';
export const SOUND_VOLUME_KEY    = 'youcoded-sound-volume';
export const SOUND_ATTENTION_KEY = 'youcoded-sound-attention';    // red status preset
export const SOUND_READY_KEY     = 'youcoded-sound-ready';        // blue status preset
export const SOUND_ATTENTION_ENABLED_KEY = 'youcoded-sound-attention-enabled';
export const SOUND_READY_ENABLED_KEY     = 'youcoded-sound-ready-enabled';
// Custom sound file paths per category
export const SOUND_CUSTOM_PATH_PREFIX = 'youcoded-sound-custom-path-'; // + category

// ── Types ────────────────────────────────────────────────────────────────────

export interface SoundPreset {
  id: string;
  label: string;
  /** Synthesize the sound at the given volume (0–1) */
  play: (volume: number) => void;
}

export type SoundCategory = 'attention' | 'ready';

// ── Synthesizer helpers ──────────────────────────────────────────────────────

function synth(recipe: (ctx: AudioContext, gain: GainNode) => void, volume: number) {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    recipe(ctx, gain);
    setTimeout(() => ctx.close(), 1500);
  } catch (e) {
    // Log instead of silently swallowing — previously any AudioContext construction
    // failure (autoplay policy, per-page AudioContext cap, sandbox restriction) was
    // invisible and made remote debugging of "sound not playing" impossible.
    console.warn('[sound] synth failed', e);
  }
}

/** Two-tone ascending chime */
function twoTone(freqs: [number, number], type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.3);
    });
  }, volume);
}

/** Three-note arpeggio */
function triTone(freqs: [number, number, number], type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.1);
      osc.stop(ctx.currentTime + i * 0.1 + 0.25);
    });
  }, volume);
}

/** Single short pulse */
function pulse(freq: number, type: OscillatorType = 'sine', duration = 0.15) {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration + 0.05);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }, volume);
}

/** Two-tone descending (for alerts) */
function descending(freqs: [number, number], type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.3);
    });
  }, volume);
}

/** Soft double-tap */
function doubleTap(freq: number, type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    [0, 0.12].forEach((offset) => {
      const g = ctx.createGain();
      g.connect(gain);
      g.gain.setValueAtTime(1, ctx.currentTime + offset);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.1);
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(g);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.1);
    });
  }, volume);
}

// ── Stock preset definitions (shared across both categories) ────────────────

export const STOCK_PRESETS: SoundPreset[] = [
  { id: 'chime',     label: 'Chime',     play: twoTone([523.25, 659.25]) },             // C5 → E5
  { id: 'bell',      label: 'Bell',      play: twoTone([659.25, 783.99], 'triangle') }, // E5 → G5
  { id: 'arpeggio',  label: 'Arpeggio',  play: triTone([523.25, 659.25, 783.99]) },     // C5 → E5 → G5
  { id: 'soft',      label: 'Soft',      play: pulse(440, 'sine', 0.25) },               // A4 gentle
  { id: 'sparkle',   label: 'Sparkle',   play: triTone([783.99, 987.77, 1174.66], 'triangle') }, // G5 → B5 → D6
  { id: 'drop',      label: 'Drop',      play: descending([783.99, 523.25]) },            // G5 → C5
  { id: 'nudge',     label: 'Nudge',     play: doubleTap(440) },                          // A4 double tap
  { id: 'alert',     label: 'Alert',     play: descending([880, 659.25]) },               // A5 → E5
  { id: 'ping',      label: 'Ping',      play: pulse(880, 'triangle', 0.12) },            // A5 short
  { id: 'knock',     label: 'Knock',     play: doubleTap(330, 'triangle') },              // E4 soft knock
  { id: 'pop',       label: 'Pop',       play: pulse(587.33, 'sine', 0.1) },              // D5 short pop
  { id: 'blip',      label: 'Blip',      play: pulse(698.46, 'triangle', 0.08) },         // F5 blip
  { id: 'rise',      label: 'Rise',      play: twoTone([392, 523.25]) },                  // G4 → C5
  { id: 'bubble',    label: 'Bubble',    play: twoTone([493.88, 587.33], 'triangle') },   // B4 → D5
  { id: 'ding',      label: 'Ding',      play: pulse(1046.5, 'sine', 0.15) },             // C6 ding
];

// Special ID indicating user chose a custom sound file
export const CUSTOM_SOUND_ID = '__custom__';

// ── Custom sound file playback ──────────────────────────────────────────────

/** Cache of decoded audio buffers keyed by file path, avoids re-fetching */
const audioBufferCache = new Map<string, AudioBuffer>();

/** Is this path an AIFF file? Chromium can't decode AIFF; we parse it in JS. */
function isAiffPath(filePath: string): boolean {
  return /\.(aiff|aif|aifc)$/i.test(filePath);
}

/**
 * Build a file:// URL from an absolute path, URL-encoding path segments so
 * macOS paths with spaces (e.g. /Users/First Last/Music/foo.aiff) or unicode
 * characters don't produce a malformed URL that fetch rejects. Windows
 * backslashes are normalized to forward slashes first.
 */
function fileUrlFromPath(filePath: string): string {
  if (filePath.startsWith('file://')) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  // encodeURI preserves / and : but encodes spaces/unicode/etc.
  const encoded = encodeURI(normalized);
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * Parse 80-bit IEEE 754 extended precision float (big-endian) used by AIFF for
 * sample rate. AIFF stores sample rate this way because it predates IEEE 754
 * doubles — real-world files almost always use integer rates (44100, 48000).
 */
function readIeee80(view: DataView, offset: number): number {
  const sign = (view.getUint8(offset) & 0x80) ? -1 : 1;
  const exponent = ((view.getUint8(offset) & 0x7f) << 8) | view.getUint8(offset + 1);
  let mantissa = 0;
  for (let i = 0; i < 8; i++) {
    mantissa = mantissa * 256 + view.getUint8(offset + 2 + i);
  }
  if (exponent === 0 && mantissa === 0) return 0;
  // Bias for 80-bit extended is 16383; mantissa is 64 bits with explicit leading 1
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63);
}

/**
 * Decode an AIFF/AIFC file into an AudioBuffer. Handles uncompressed big-endian
 * PCM (8/16/24/32-bit). AIFC with compression (e.g. μ-law, IMA4) is not supported —
 * the COMM compressionType will be something other than 'NONE'/'sowt', and we
 * throw so the caller can log and the user can pick a different sound.
 */
function parseAiffToAudioBuffer(ctx: AudioContext, arrayBuffer: ArrayBuffer): AudioBuffer {
  const view = new DataView(arrayBuffer);
  const readAscii = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };

  if (readAscii(0, 4) !== 'FORM') throw new Error('Not an AIFF file (missing FORM)');
  const formType = readAscii(8, 4); // 'AIFF' or 'AIFC'
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new Error(`Unsupported FORM type: ${formType}`);
  }

  let channels = 0;
  let numFrames = 0;
  let bitDepth = 0;
  let sampleRate = 0;
  let compression: 'NONE' | 'sowt' = 'NONE'; // 'sowt' = little-endian PCM (rare but valid)
  let ssndOffset = 0;
  let ssndSize = 0;

  let cursor = 12; // skip 'FORM' + size + 'AIFF'/'AIFC'
  while (cursor < view.byteLength - 8) {
    const chunkId = readAscii(cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, false);
    const dataStart = cursor + 8;

    if (chunkId === 'COMM') {
      channels = view.getUint16(dataStart, false);
      numFrames = view.getUint32(dataStart + 2, false);
      bitDepth = view.getUint16(dataStart + 6, false);
      sampleRate = readIeee80(view, dataStart + 8);
      if (formType === 'AIFC' && chunkSize >= 22) {
        const comp = readAscii(dataStart + 18, 4);
        if (comp !== 'NONE' && comp !== 'sowt') {
          throw new Error(`Unsupported AIFC compression: ${comp}`);
        }
        compression = comp as 'NONE' | 'sowt';
      }
    } else if (chunkId === 'SSND') {
      const ssndDataOffset = view.getUint32(dataStart, false); // usually 0
      ssndOffset = dataStart + 8 + ssndDataOffset;
      ssndSize = chunkSize - 8 - ssndDataOffset;
    }

    // Chunks are padded to even size
    cursor = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!channels || !numFrames || !bitDepth || !sampleRate || !ssndSize) {
    throw new Error('AIFF missing required COMM/SSND fields');
  }

  const bytesPerSample = bitDepth / 8;
  const buffer = ctx.createBuffer(channels, numFrames, sampleRate);
  const bigEndian = compression !== 'sowt'; // sowt = little-endian

  for (let ch = 0; ch < channels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let frame = 0; frame < numFrames; frame++) {
      const sampleOffset = ssndOffset + (frame * channels + ch) * bytesPerSample;
      let sample = 0;
      if (bitDepth === 16) {
        sample = view.getInt16(sampleOffset, !bigEndian) / 0x8000;
      } else if (bitDepth === 24) {
        // 24-bit signed PCM — DataView has no int24, assemble manually
        const b0 = view.getUint8(sampleOffset);
        const b1 = view.getUint8(sampleOffset + 1);
        const b2 = view.getUint8(sampleOffset + 2);
        let s = bigEndian ? ((b0 << 16) | (b1 << 8) | b2) : ((b2 << 16) | (b1 << 8) | b0);
        if (s & 0x800000) s -= 0x1000000; // sign extend
        sample = s / 0x800000;
      } else if (bitDepth === 32) {
        sample = view.getInt32(sampleOffset, !bigEndian) / 0x80000000;
      } else if (bitDepth === 8) {
        // 8-bit AIFF is signed (unlike WAV which is unsigned)
        sample = view.getInt8(sampleOffset) / 0x80;
      }
      channelData[frame] = sample;
    }
  }

  return buffer;
}

/**
 * Play a custom audio file at the given volume.
 * Uses fetch + decodeAudioData for formats Chromium supports; routes AIFF
 * through the JS parser above. Falls back to HTMLAudioElement for anything
 * decodeAudioData rejects.
 */
async function playCustomFile(filePath: string, volume: number) {
  const fileUrl = fileUrlFromPath(filePath);
  try {
    const ctx = new AudioContext();

    let buffer = audioBufferCache.get(filePath);
    if (!buffer) {
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      buffer = isAiffPath(filePath)
        ? parseAiffToAudioBuffer(ctx, arrayBuffer)
        : await ctx.decodeAudioData(arrayBuffer);
      audioBufferCache.set(filePath, buffer);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    source.onended = () => ctx.close();
  } catch (e) {
    console.warn('[sound] custom file playback failed, trying HTMLAudioElement fallback', filePath, e);
    try {
      const audio = new Audio(fileUrl);
      audio.volume = volume;
      await audio.play();
    } catch (e2) {
      console.warn('[sound] HTMLAudioElement fallback also failed', filePath, e2);
    }
  }
}

/** Get the stored custom sound file path for a category */
export function getCustomSoundPath(cat: SoundCategory): string | null {
  try {
    return localStorage.getItem(SOUND_CUSTOM_PATH_PREFIX + cat);
  } catch { return null; }
}

/** Set the custom sound file path for a category */
export function setCustomSoundPath(cat: SoundCategory, path: string | null) {
  try {
    if (path) {
      localStorage.setItem(SOUND_CUSTOM_PATH_PREFIX + cat, path);
    } else {
      localStorage.removeItem(SOUND_CUSTOM_PATH_PREFIX + cat);
    }
  } catch {}
}

/** Extract a display name from a file path (just the filename without extension) */
export function getCustomSoundDisplayName(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() || path;
  return name.replace(/\.[^.]+$/, '');
}

// ── Lookup helpers ───────────────────────────────────────────────────────────

const STORAGE_KEYS: Record<SoundCategory, string> = {
  attention: SOUND_ATTENTION_KEY,
  ready:     SOUND_READY_KEY,
};

export function getSelectedPresetId(cat: SoundCategory): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS[cat]);
    if (stored === CUSTOM_SOUND_ID) return CUSTOM_SOUND_ID;
    if (stored && STOCK_PRESETS.some((p) => p.id === stored)) return stored;
  } catch {}
  return STOCK_PRESETS[0].id; // default to first
}

export function setSelectedPresetId(cat: SoundCategory, id: string) {
  try { localStorage.setItem(STORAGE_KEYS[cat], id); } catch {}
}

// ── Global getters ───────────────────────────────────────────────────────────

export function isSoundMuted(): boolean {
  try { return localStorage.getItem(SOUND_MUTED_KEY) === '1'; } catch { return false; }
}

export function getSoundVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY) || '0.3');
    return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
  } catch { return 0.3; }
}

export function isCategoryEnabled(cat: SoundCategory): boolean {
  const key = cat === 'attention' ? SOUND_ATTENTION_ENABLED_KEY : SOUND_READY_ENABLED_KEY;
  try {
    const v = localStorage.getItem(key);
    return v === null ? true : v === '1'; // default: enabled
  } catch { return true; }
}

export function setCategoryEnabled(cat: SoundCategory, enabled: boolean) {
  const key = cat === 'attention' ? SOUND_ATTENTION_ENABLED_KEY : SOUND_READY_ENABLED_KEY;
  try { localStorage.setItem(key, enabled ? '1' : '0'); } catch {}
}

// ── Play by category ─────────────────────────────────────────────────────────

/** Play the user's selected sound for a category, respecting mute & volume */
export function playSound(cat: SoundCategory) {
  if (isSoundMuted()) return;
  if (!isCategoryEnabled(cat)) return;
  const vol = getSoundVolume();
  const presetId = getSelectedPresetId(cat);

  // Custom sound file
  if (presetId === CUSTOM_SOUND_ID) {
    const path = getCustomSoundPath(cat);
    if (path) playCustomFile(path, vol);
    return;
  }

  const preset = STOCK_PRESETS.find((p) => p.id === presetId) || STOCK_PRESETS[0];
  preset.play(vol);
}

/** Play a specific preset at current volume (for preview/test) */
export function playPreview(presetId: string, cat?: SoundCategory) {
  const vol = getSoundVolume();

  // Custom sound preview
  if (presetId === CUSTOM_SOUND_ID && cat) {
    const path = getCustomSoundPath(cat);
    if (path) playCustomFile(path, vol);
    return;
  }

  const preset = STOCK_PRESETS.find((p) => p.id === presetId) || STOCK_PRESETS[0];
  preset.play(vol);
}
