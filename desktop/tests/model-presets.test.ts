// Guards for the router's per-model settings file (design §C2).
//
// Everything asserted here about llama.cpp's INI grammar was MEASURED against
// the pinned binary (b10665) on 2026-09-05 and cross-read against its own
// `common/preset.cpp`; test-engine/probe-presets.mjs is the half that re-proves
// it on a real engine. The stakes are why the hostile cases are so many: a
// defect in this file is not a per-model failure, it is llama-server exiting 1
// at startup with every local model gone and nothing on screen to explain it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  renderPresetFile, writePresetFile, presetFilePath, parseExtraFlags, normaliseArgKey,
  isReservedKey, isWritableSectionName, modelSectionEntries, checkFlagsAgainstBinary,
  engineErrorLine, RESERVED_KEYS,
} from '../src/main/engine/model-presets';
import type { ModelSettings } from '../src/shared/model-manager-types';

const DEFAULTS: ModelSettings = {
  contextLength: null, keepLoaded: false, gpuLayers: 'auto', extraFlags: '',
};
const base = { contextSize: 32768, sleepIdleSeconds: 300 };

/** The section body for one id, as lines, or null when it got no section. */
function section(file: string, id: string): string[] | null {
  const lines = file.split('\n');
  const start = lines.indexOf(`[${id}]`);
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('['); i++) {
    if (lines[i]) out.push(lines[i]);
  }
  return out;
}

describe('model-presets — the [*] global block', () => {
  it('writes the engine-wide context length and auto-sleep, and writes them FIRST', () => {
    const file = renderPresetFile({ ...base, modelIds: [] });
    expect(file.split('\n').slice(0, 3)).toEqual(['[*]', 'ctx-size = 32768', 'sleep-idle-seconds = 300']);
  });

  it('drops a context length that could not be a context length', () => {
    for (const contextSize of [0, -5]) {
      expect(renderPresetFile({ contextSize, sleepIdleSeconds: 300, modelIds: [] })).not.toMatch(/ctx-size/);
    }
  });

  it('drops a value that is not a real number rather than writing it', () => {
    // `ctx-size = NaN` is not a parse error — it is a std::stoi throw when the
    // model loads, which kills that model with a message no user can act on.
    const file = renderPresetFile({ contextSize: Number.NaN, sleepIdleSeconds: 300, modelIds: [] });
    expect(file).not.toMatch(/ctx-size/);
    expect(file).toMatch(/sleep-idle-seconds = 300/);
  });
});

describe('model-presets — which models get a section', () => {
  it('writes a section only for an id the cache scan found', () => {
    const file = renderPresetFile({
      ...base,
      modelIds: ['present'],
      settings: { present: { ...DEFAULTS, contextLength: 8192 }, deleted: { ...DEFAULTS, contextLength: 4096 } },
    });
    expect(section(file, 'present')).toEqual(['ctx-size = 8192']);
    // A stale section resurrects a deleted model as a ghost row that can never
    // load and cannot be removed from inside the app (probed).
    expect(section(file, 'deleted')).toBeNull();
  });

  it('writes no section for a model that is on every default', () => {
    const file = renderPresetFile({ ...base, modelIds: ['plain'], settings: { plain: { ...DEFAULTS } } });
    expect(section(file, 'plain')).toBeNull();
  });

  it('writes each of the three per-model keys only when it is set', () => {
    const file = renderPresetFile({
      ...base,
      modelIds: ['m'],
      settings: { m: { contextLength: 16384, keepLoaded: true, gpuLayers: 24, extraFlags: '--temp 0.6' } },
    });
    expect(section(file, 'm')).toEqual([
      'ctx-size = 16384', 'n-gpu-layers = 24', 'sleep-idle-seconds = -1', 'temperature = 0.6',
    ]);
  });

  it("omits n-gpu-layers for 'auto' and writes 999 for all-layers", () => {
    const auto = renderPresetFile({ ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, gpuLayers: 'auto', keepLoaded: true } } });
    expect(section(auto, 'm')).toEqual(['sleep-idle-seconds = -1']);
    const all = renderPresetFile({ ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, gpuLayers: 999 } } });
    expect(section(all, 'm')).toEqual(['n-gpu-layers = 999']);
  });

  it('never reads a settings key it does not OWN', () => {
    // Model ids are FILENAMES, so `constructor.gguf` is a file a user can make,
    // and a plain-object lookup would answer with a Function.
    expect(section(renderPresetFile({ ...base, modelIds: ['constructor'], settings: {} }), 'constructor')).toBeNull();
    // The one that is not merely theoretical: settings reached through a
    // PROTOTYPE rather than the file's own keys. A plain lookup cannot tell the
    // two apart and would apply a setting config.json does not contain.
    const inherited = Object.create({ ghost: { ...DEFAULTS, contextLength: 4096 } });
    expect(section(renderPresetFile({ ...base, modelIds: ['ghost'], settings: inherited }), 'ghost')).toBeNull();
  });

  it('drops a context length that is zero or negative', () => {
    for (const contextLength of [0, -5]) {
      const file = renderPresetFile({ ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, contextLength } } });
      expect(section(file, 'm')).toBeNull();
    }
  });
});

describe('model-presets — hostile model ids (they are filenames)', () => {
  it.each([
    ['a]b', 'a `]` ends the header early and the WHOLE file fails to parse'],
    ['a\nb', 'a line break does the same'],
    [' leading', 'a leading space is eaten by the grammar, so it reads back as a different, ghost model'],
    ['\tleading', 'so is a leading tab'],
    ['', 'an empty header is not a header'],
  ])('refuses to write a section for %j (%s)', (id) => {
    expect(isWritableSectionName(id)).toBe(false);
    const file = renderPresetFile({ ...base, modelIds: [id], settings: { [id]: { ...DEFAULTS, contextLength: 4096 } } });
    expect(file).not.toContain(`[${id}]`);
    expect(file).not.toContain('4096');
  });

  it('refuses a model literally called "*" — a second [*] header RESETS the global block', () => {
    expect(isWritableSectionName('*')).toBe(false);
    const file = renderPresetFile({ ...base, modelIds: ['*'], settings: { '*': { ...DEFAULTS, contextLength: 4096 } } });
    expect(file.split('\n').filter((l) => l === '[*]')).toHaveLength(1); // the global one, and only it
    expect(file).not.toContain('4096');
  });

  it.each(['a[b', 'a#b', 'a=b', 'a\tb', 'trailing ', 'café-ø'])(
    'still writes a section for %j — verified to round-trip on b10665', (id) => {
      expect(isWritableSectionName(id)).toBe(true);
      const file = renderPresetFile({ ...base, modelIds: [id], settings: { [id]: { ...DEFAULTS, contextLength: 4096 } } });
      expect(section(file, id)).toEqual(['ctx-size = 4096']);
    }
  );

  it('writes a repeated id once — a duplicate header ERASES the first section', () => {
    const file = renderPresetFile({
      ...base, modelIds: ['dup', 'dup'], settings: { dup: { ...DEFAULTS, contextLength: 4096 } },
    });
    expect(file.split('\n').filter((l) => l === '[dup]')).toHaveLength(1);
  });
});

describe('model-presets — the extra-flag tokeniser', () => {
  it('turns --key value into key = value and a bare --key into key = 1', () => {
    const r = parseExtraFlags('--temperature 0.6 --flash-attn');
    expect(r).toEqual({ ok: true, entries: [{ key: 'temperature', value: '0.6' }, { key: 'flash-attn', value: '1' }] });
  });

  it('reads a negative number as a VALUE, not as another option', () => {
    // `--n-predict -1` is a real thing to type; a tokeniser that treats one dash
    // as an option name refuses it for no reason.
    expect(parseExtraFlags('--n-predict -1')).toEqual({ ok: true, entries: [{ key: 'n-predict', value: '-1' }] });
  });

  it('keeps the last value when the same option is typed twice, however it is spelled', () => {
    const r = parseExtraFlags('--temp 0.6 --temperature 0.9');
    expect(r).toEqual({ ok: true, entries: [{ key: 'temperature', value: '0.9' }] });
  });

  it('rejects a value that does not follow an option', () => {
    const r = parseExtraFlags('0.6');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('does not follow an option');
  });

  it.each(['-c 4096', '--1st 2', '---x 1', '--a.b] 1'])('rejects the badly-shaped %j', (raw) => {
    const r = parseExtraFlags(raw);
    expect(r.ok).toBe(false);
  });

  it.each([
    ['--chat-template a#b', '#'],
    ['--chat-template x;y', ';'],
  ])('rejects %j, because the engine SILENTLY cuts the value at the %s', (raw) => {
    const r = parseExtraFlags(raw);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('comment');
  });

  it('rejects a control character in a value', () => {
    const r = parseExtraFlags('--chat-template a\u0007b');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('control characters');
  });
});

describe('model-presets — alias normalisation and the reserved list', () => {
  it('collapses short, long and environment spellings onto one canonical name', () => {
    expect(normaliseArgKey('--c')).toBe('ctx-size');
    expect(normaliseArgKey('ctx-size')).toBe('ctx-size');
    expect(normaliseArgKey('LLAMA_ARG_CTX_SIZE')).toBe('ctx-size');
    expect(normaliseArgKey('--ngl')).toBe('n-gpu-layers');
    expect(normaliseArgKey('--temp')).toBe('temperature');
  });

  it('cannot be fooled into returning a Function for an inherited name', () => {
    // engine-pin's table is prototype-less on purpose; copying it into a plain
    // object would make `--valueOf` resolve to Function.prototype.valueOf, sail
    // past a string denylist, and be stringified into the file.
    for (const name of ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(normaliseArgKey(`--${name}`)).toBe(name);
    }
    expect(parseExtraFlags('--valueOf 1')).toEqual({ ok: true, entries: [{ key: 'valueOf', value: '1' }] });
  });

  it('rejects every reserved option, including through an alias', () => {
    for (const key of RESERVED_KEYS) expect(isReservedKey(key)).toBe(true);
    for (const raw of ['--ctx-size 8192', '--c 8192', '--LLAMA_ARG_CTX_SIZE 8192', '--ngl 20', '--m /tmp/x.gguf', '--alias x']) {
      const r = parseExtraFlags(raw);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message).toContain('YouCoded');
    }
  });

  it('strips a leading no- before the reserved check, and only then', () => {
    // A negative spelling normalises to its OWN canonical key, so without the
    // strip `--no-host` walks straight past a list that only knows `host`.
    expect(isReservedKey('no-host')).toBe(true);
    expect(parseExtraFlags('--no-host').ok).toBe(false);
    // …but the strip must not swallow options that merely start with "no-":
    // `--no-mmap` is the user asking for the opposite of `--mmap`, and llama.cpp
    // keeps it as its own key.
    expect(parseExtraFlags('--no-mmap')).toEqual({ ok: true, entries: [{ key: 'no-mmap', value: '1' }] });
    // And the OFF short forms do not look negative at all until they are
    // normalised, which is the other half of why the order matters.
    expect(normaliseArgKey('--nkvo')).toBe('no-kv-offload');
    expect(parseExtraFlags('--nkvo')).toEqual({ ok: true, entries: [{ key: 'no-kv-offload', value: '1' }] });
  });

  it('drops an unsaveable extra-flags string rather than writing it into the file', () => {
    // Reaching this means config.json was hand-edited or written by an older
    // build: the flags cost that one user their customisation, the file costs
    // EVERY model on the next spawn.
    const file = renderPresetFile({
      ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, contextLength: 4096, extraFlags: '--alias a#b' } },
    });
    expect(section(file, 'm')).toEqual(['ctx-size = 4096']);
  });

  it('a managed option typed into the extra-flags box cannot change what is written', () => {
    // It is refused as reserved long before this point; the assertion is that the
    // section still reflects the Context length control and nothing else.
    expect(modelSectionEntries({ contextLength: 4096, keepLoaded: false, gpuLayers: 'auto', extraFlags: '--ctx-size 99' }))
      .toEqual([{ key: 'ctx-size', value: '4096' }]);
  });
});

describe('model-presets — writing the file', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-presets-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('creates ~/.youcoded/engine/ and lands the file whole', () => {
    const target = presetFilePath(root);
    expect(target).toBe(path.join(root, 'engine', 'models.ini'));
    writePresetFile(target, renderPresetFile({ ...base, modelIds: [] }));
    expect(fs.readFileSync(target, 'utf8')).toContain('ctx-size = 32768');
    // Temp file + rename, never a partial file: ~/.youcoded is shared between a
    // dev instance and the built app, and a reader that catches half of this
    // file gets an engine that will not start.
    expect(fs.readdirSync(path.join(root, 'engine'))).toEqual(['models.ini']);
  });

  it('uses a per-process temp name so two writers never share one', () => {
    // A directory where the file goes makes the rename — and only the rename —
    // fail, which leaves the temp file on disk under its real name.
    const target = presetFilePath(root);
    fs.mkdirSync(target, { recursive: true });
    expect(() => writePresetFile(target, 'x')).toThrow();
    expect(fs.existsSync(`${target}.${process.pid}.tmp`)).toBe(true);
  });
});

// A stand-in for the spawned llama-server: exactly the surface the check uses.
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}

describe('model-presets — asking the binary whether a flag is real', () => {
  const entries = [{ key: 'not-a-real-flag', value: '7' }];

  function run(drive: (child: FakeChild) => void, extra: Record<string, unknown> = {}) {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child) as any;
    const promise = checkFlagsAgainstBinary({
      binaryPath: '/fake/llama-server', modelId: 'gemma-4-E2B-it-Q8_0', entries, spawnImpl, timeoutMs: 50, ...extra,
    });
    setTimeout(() => drive(child), 0);
    return { promise, child, spawnImpl };
  }

  it('rejects on a non-zero exit and quotes the engine, not a guess', async () => {
    const { promise } = run((child) => {
      child.stderr.emit('data', "0.00.050.247 E srv  llama_server: failed to initialize router models: option 'not-a-real-flag' not recognized in preset 'gemma-4-E2B-it-Q8_0'\n");
      child.emit('exit', 1);
    });
    await expect(promise).resolves.toEqual({
      ok: false,
      message: "failed to initialize router models: option 'not-a-real-flag' not recognized in preset 'gemma-4-E2B-it-Q8_0'",
    });
  });

  it('accepts as soon as the engine says it is listening, and kills it', async () => {
    const { promise, child } = run((c) => c.stderr.emit('data', '0.00.045.005 I srv  llama_server: listening on http://127.0.0.1:9317\n'));
    await expect(promise).resolves.toEqual({ ok: true });
    expect(child.killed).toBe(true);
  });

  it('accepts when the check could not run at all — a verdict we did not reach is not a rejection', async () => {
    await expect(run((c) => c.emit('error', new Error('ENOENT'))).promise).resolves.toEqual({ ok: true });
    await expect(run(() => { /* silence until the timeout */ }).promise).resolves.toEqual({ ok: true });
  });

  it('does not spawn anything when there is nothing to check', async () => {
    const spawnImpl = vi.fn();
    await expect(checkFlagsAgainstBinary({
      binaryPath: '/fake/llama-server', modelId: 'm', entries: [], spawnImpl: spawnImpl as any,
    })).resolves.toEqual({ ok: true });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('checks under the model\'s own name so the engine\'s message names it, but never with an unwritable one', async () => {
    const { promise, spawnImpl } = run((c) => c.emit('exit', 1), { modelId: 'a]b' });
    await promise;
    const iniPath = spawnImpl.mock.calls[0][1][spawnImpl.mock.calls[0][1].indexOf('--models-preset') + 1];
    expect(iniPath).toMatch(/check\.ini$/);
  });
});

describe('model-presets — the message the user is shown', () => {
  it('strips only the log prefix from the engine\'s own line', () => {
    expect(engineErrorLine("0.00.050.247 E srv  llama_server: failed to initialize router models: option 'x' not recognized in preset 'y'", 1))
      .toBe("failed to initialize router models: option 'x' not recognized in preset 'y'");
  });

  it('prefers the engine\'s error line over its chatter', () => {
    const stderr = [
      '0.00.049.485 I srv   load_models: Loaded 0 cached model presets',
      '0.00.050.247 E srv  llama_server: failed to parse server config file: /tmp/x.ini',
      '0.00.050.900 I srv    operator(): cleaning up before exit...',
    ].join('\n');
    expect(engineErrorLine(stderr, 1)).toBe('failed to parse server config file: /tmp/x.ini');
  });

  it('says only what it knows when the engine said nothing', () => {
    expect(engineErrorLine('', 1)).toBe('The local engine rejected this setting and exited with code 1.');
  });
});
