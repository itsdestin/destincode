// The ONE place voice prompting's two downloads are pinned — the sherpa-onnx
// native runtime (from npm) and the Parakeet speech model (from a GitHub
// release). Same discipline as engine-pin.ts: a bump is a PR that re-runs the
// commands recorded beside each digest.
//
// TWO things are pinned per platform, not one (design: "Main — src/main/voice/"):
//   1. the integrity DIGEST, so a tampered or truncated download is refused, and
//   2. the IN-ARCHIVE RELATIVE PATH of the file we need out of it, so a layout
//      change upstream fails loudly at unpack time instead of installing a
//      directory that looks complete and cannot load.
// engine-pin.ts pins an engine asset's binaryRelPath for exactly that reason and
// engine-acquisition's post-unpack existence check enforces it; voice-assets.ts
// reuses that check verbatim.
//
// WHY the digests come in two shapes: npm publishes `dist.integrity`, which is
// SHA-512 in base64 (the SSRI "sha512-…" form); the sherpa-onnx release
// publishes SHA-256 in hex in its checksum.txt. Rather than convert one into the
// other by hand — and lose the ability to re-check a pin against its source with
// one command — each pin carries {algo, encoding, digest} and the verifier reads
// it. The command that produced each value is recorded above the table.
import * as path from 'path';

/** sherpa-onnx npm packages: the native addon and the JS wrappers move together. */
export const SHERPA_VERSION = '1.13.7';

/** Shown to the user as the engine's name (VoiceReadiness carries it). */
export const VOICE_ENGINE_LABEL = 'Parakeet TDT 0.6B v3';

/** How a file's expected fingerprint is written down. See the header for WHY
 *  this is a shape rather than a bare hex string. */
export interface DigestPin {
  algo: 'sha256' | 'sha512';
  encoding: 'hex' | 'base64';
  digest: string;
}

/** One downloadable archive: where it lives, what it must hash to, how big it
 *  is (the denominator of the download percentage), and what must exist inside
 *  it once unpacked. */
export interface VoiceArchive {
  /** Plain-language name, used in error messages the user actually reads. */
  label: string;
  url: string;
  digest: DigestPin;
  /** Exact size of the DOWNLOAD in bytes, measured with the command below.
   *  Pinned rather than read from Content-Length because the combined
   *  percentage has to be known before the first byte arrives. */
  bytes: number;
  /** Paths inside the archive that MUST exist after unpacking. Empty is not
   *  allowed — this is the stale-layout tripwire. */
  requiredRelPaths: string[];
}

export interface VoiceRuntimePin extends VoiceArchive {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64' | 'ia32';
  npmPackage: string;
  /** The native addon inside the archive. Verified 2026-09-05 by listing all
   *  six tarballs: every one is rooted at `package/` with the addon and its
   *  sibling shared libraries (.so/.dylib/.dll) flat beside it. */
  addonRelPath: string;
}

/** npm serves every tarball from the same predictable path. */
export function npmTarballUrl(pkg: string, version: string): string {
  return `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
}

// Digests below: `curl -s https://registry.npmjs.org/<pkg>/1.13.7 | python3 -c
//   'import sys,json;d=json.load(sys.stdin);print(d["dist"]["integrity"])'`
// Sizes below: `curl -s -r 0-0 -D - -o /dev/null <tarball url>` → Content-Range
//   total. Both read 2026-09-05.
//
// `win-arm64` IS ABSENT and that is not an oversight: sherpa-onnx publishes no
// such package (the registry answers 404, checked 2026-09-05 alongside the six
// below). A Windows-on-ARM machine gets `unsupportedReason()`'s sentence, not a
// failed download. `win-ia32` (32-bit Windows) DOES exist and is supported.
export const VOICE_RUNTIMES: VoiceRuntimePin[] = [
  {
    platform: 'linux', arch: 'x64', npmPackage: 'sherpa-onnx-linux-x64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-linux-x64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'npmxn5WwmAmlthgBhmbZ33t3i2j4mJwQt46dMEb3j7d41y1/uJrjrVAfa/DkvV+vn49ZWfcQ2UEWDipaZBVhuw==' },
    bytes: 10810981,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'linux', arch: 'arm64', npmPackage: 'sherpa-onnx-linux-arm64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-linux-arm64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'TFCVpXyTh69buhOtTS8KIfkRXOVKY4Y1qjAktSItrKS4A0chnnrlXO5bKWoNAPeI6fMxTF/uvMYbYgcvjEMfNg==' },
    bytes: 13605393,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'win32', arch: 'x64', npmPackage: 'sherpa-onnx-win-x64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-win-x64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'wBV1o+/zgsMrOjfCFIgGrH6S28xq6CqRCLSavCOjTZ6cqr80yGc07DUHxqsHFPZvfoJU+2JF5L2l3gyWFWoWdQ==' },
    bytes: 8705089,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'win32', arch: 'ia32', npmPackage: 'sherpa-onnx-win-ia32',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-win-ia32', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'sTwtpxPQ76XLn0giAbvknIDEDKD3XXi2mo2AVROEucf1pIK1DjQl+LjLkalTeFoQqbC4J3xGx/g+xgcHQD1dsw==' },
    bytes: 7572131,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'darwin', arch: 'x64', npmPackage: 'sherpa-onnx-darwin-x64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-darwin-x64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'N3o+T+wn9WaQmsKV5DD8bTHdo+WN2+sXwmZcGJZiDjtOMR2zFz7uVCZnYCmEAMgvChC+oHcF5RvEEKcRCAu6Pw==' },
    bytes: 11151181,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'darwin', arch: 'arm64', npmPackage: 'sherpa-onnx-darwin-arm64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-darwin-arm64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: '5NCE50hAvr3n2pdett0SgfPBJXaFZE0bqHwbHyiq+IKZ8Ids0l4M0VrG+ImGYIafCwie+oC3uAJ+pKj9xg/k+w==' },
    bytes: 10015211,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
];

/** The platform-independent JS half of sherpa-onnx.
 *
 *  WHY it is a SECOND download unpacked ON TOP of the runtime: the native
 *  addon alone is a bag of C functions; `OfflineRecognizer` and friends are
 *  plain JavaScript in this package. Its loader (`addon.js`) tries five paths
 *  for the addon, and the fifth is `./sherpa-onnx.node` — the same directory —
 *  so unpacking these files beside the addon is what makes the pair resolve
 *  with no `node_modules` anywhere in sight. Read out of the published
 *  addon.js, 2026-09-05.
 *
 *  Both tarballs are rooted at `package/`, so this one is unpacked SECOND and
 *  its package.json (whose `main` is sherpa-onnx.js) deliberately wins. */
export const VOICE_WRAPPERS: VoiceArchive & { npmPackage: string; entryRelPath: string } = {
  npmPackage: 'sherpa-onnx-node',
  label: 'the speech runtime',
  url: npmTarballUrl('sherpa-onnx-node', SHERPA_VERSION),
  digest: { algo: 'sha512', encoding: 'base64', digest: '0XGV7arGngBCnol0m8OLyqlnaUm19Q1KmetVj1DDBdymXa1upmAHZDwNdN47gjsEhqE5hXUEyc1vRQoXrNhNVg==' },
  bytes: 11954,
  entryRelPath: 'package/sherpa-onnx.js',
  requiredRelPaths: ['package/sherpa-onnx.js', 'package/non-streaming-asr.js', 'package/addon.js'],
};

/** The directory the model archive unpacks to — its own name, inside the tar. */
export const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

// Size and digest: the release's own checksum.txt plus
//   `curl -sL -r 0-0 -D - -o /dev/null <url>` → Content-Range total, read
//   2026-09-05. The four required paths were read off the archive's own index
//   the same day (`curl -sL -r 0-25000000 <url> | bzip2 -dc | tar -tv`).
/** The four files the recogniser opens, named ONCE. The archive's contents and
 *  the engine's config are the same four names, and spelling them in two places
 *  means a re-pinned model archive passes every test and then fails at load with
 *  the engine's own words about a missing file. */
export const MODEL_FILES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt',
} as const;

export const VOICE_MODEL: VoiceArchive = {
  label: 'the speech model',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
  digest: { algo: 'sha256', encoding: 'hex', digest: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf' },
  bytes: 487170055,
  requiredRelPaths: [
    `${MODEL_DIR_NAME}/${MODEL_FILES.encoder}`,
    `${MODEL_DIR_NAME}/${MODEL_FILES.decoder}`,
    `${MODEL_DIR_NAME}/${MODEL_FILES.joiner}`,
    `${MODEL_DIR_NAME}/${MODEL_FILES.tokens}`,
  ],
};

/** Every byte the first-run download has to move. The progress percentage is
 *  over this, so the bar never restarts between the three archives. */
export function totalDownloadBytes(runtime: VoiceRuntimePin): number {
  return runtime.bytes + VOICE_WRAPPERS.bytes + VOICE_MODEL.bytes;
}

export function pickRuntime(platform: NodeJS.Platform | string, arch: string): VoiceRuntimePin | null {
  return VOICE_RUNTIMES.find((r) => r.platform === platform && r.arch === arch) ?? null;
}

/** The user-facing sentence for a machine voice cannot run on, or null if it
 *  can. Specific and true (docs/error-message-standards.md): it names the
 *  actual machine, because the only case today is Windows on ARM, where the
 *  speech runtime is simply not published. */
export function unsupportedReason(platform: NodeJS.Platform | string, arch: string): string | null {
  if (pickRuntime(platform, arch)) return null;
  return `Voice typing is not available on this computer (${platform} ${arch}) — the speech engine is not published for it.`;
}

// ---------------------------------------------------------------------------
// Where it all lands on disk. Everything below is a pure path function so the
// worker (a separate process) and the service agree without either hardcoding a
// directory name — voice-worker.ts imports addonPath() rather than rebuilding it.
// ---------------------------------------------------------------------------

/** `<userData>/voice` — per-machine, never synced (it is hundreds of MB of
 *  machine-specific binaries). Listed in docs/MAP.md's on-disk state table. */
export function voiceRoot(userDataPath: string): string {
  return path.join(userDataPath, 'voice');
}

/** `<userData>/voice/runtime` — the unpacked native addon + JS wrappers. */
export function runtimeDir(userDataPath: string): string {
  return path.join(voiceRoot(userDataPath), 'runtime');
}

/** Absolute path of the native addon. THE export voice-worker.ts require()s;
 *  nothing else may rebuild this string. */
export function addonPath(userDataPath: string): string {
  return path.join(runtimeDir(userDataPath), 'package', 'sherpa-onnx.node');
}

/** Absolute path of the JS wrapper entry (`OfflineRecognizer` lives behind it). */
export function wrapperEntryPath(userDataPath: string): string {
  return path.join(runtimeDir(userDataPath), 'package', 'sherpa-onnx.js');
}

/** Absolute path of the unpacked model directory (the one holding
 *  encoder/decoder/joiner/tokens), which sherpa's recognizer config wants. */
export function modelDir(userDataPath: string): string {
  return path.join(voiceRoot(userDataPath), 'model', MODEL_DIR_NAME);
}
