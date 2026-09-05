import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ModelDownloader } from '../src/main/models/model-downloader';
import type { DownloadProgress, QuantOption } from '../src/shared/model-manager-types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PART1 = Buffer.from('part-one-bytes');
const PART2 = Buffer.from('part-two-bytes!!');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Serves resolve URLs by trailing filename, honoring Range. */
function fetchServing(bodies: Record<string, Buffer>): typeof fetch {
  return (async (url: any, init?: any) => {
    const name = decodeURIComponent(String(url).split('/').pop()!);
    const buf = bodies[name];
    if (!buf) return new Response(null, { status: 404 });
    let start = 0;
    const range = init?.headers?.Range as string | undefined;
    if (range) start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const body = buf.subarray(start);
    return new Response(new Blob([body]).stream(), {
      status: start > 0 ? 206 : 200,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof fetch;
}

function quantOpt(withSha = true): QuantOption {
  return {
    quant: 'UD-Q4_K_XL', description: 'x',
    files: ['sub/M-UD-Q4_K_XL-00001-of-00002.gguf', 'sub/M-UD-Q4_K_XL-00002-of-00002.gguf'],
    totalSizeBytes: PART1.length + PART2.length,
    sha256ByFile: {
      'sub/M-UD-Q4_K_XL-00001-of-00002.gguf': withSha ? sha(PART1) : null,
      'sub/M-UD-Q4_K_XL-00002-of-00002.gguf': withSha ? sha(PART2) : null,
    },
  };
}
const bodies = {
  'M-UD-Q4_K_XL-00001-of-00002.gguf': PART1,
  'M-UD-Q4_K_XL-00002-of-00002.gguf': PART2,
};

describe('ModelDownloader', () => {
  it('downloads all parts FLAT into the cache dir (basenames), verifies sha256, reports done', async () => {
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/M-GGUF', quantOpt(), (p) => events.push(p));
    await dl.wait(id);
    // Flat basenames → cache-scan/router discovery sees them (Plan B convention).
    expect(fs.readFileSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))).toEqual(PART1);
    expect(fs.readFileSync(path.join(dir, 'M-UD-Q4_K_XL-00002-of-00002.gguf'))).toEqual(PART2);
    const last = events[events.length - 1];
    expect(last.state).toBe('done');
    expect(last.receivedBytes).toBe(PART1.length + PART2.length);
    expect(events.some((e) => e.state === 'verifying')).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('resumes a part from its .partial file via Range', async () => {
    fs.writeFileSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf.partial'), PART1.subarray(0, 5));
    const fetchImpl = vi.fn(fetchServing(bodies));
    const dl = new ModelDownloader(dir, fetchImpl as any);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id);
    expect(fs.readFileSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))).toEqual(PART1);
    const firstCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('00001'));
    expect((firstCall![1] as any).headers.Range).toBe('bytes=5-');
  });

  it('sha256 mismatch → error state, bad file deleted, nothing published', async () => {
    const bad = quantOpt();
    bad.sha256ByFile['sub/M-UD-Q4_K_XL-00001-of-00002.gguf'] = '0'.repeat(64);
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/M-GGUF', bad, (p) => events.push(p));
    await expect(dl.wait(id)).rejects.toThrow(/integrity/);
    expect(events[events.length - 1].state).toBe('error');
    expect(fs.existsSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))).toBe(false);
  });

  it('cancel: stops the stream, emits cancelled, KEEPS the .partial for resume', async () => {
    // A fetch whose body streams 4 bytes every 20ms until the abort signal
    // fires. The fake MUST honor init.signal (K3) — real fetch rejects the
    // in-flight read on abort; without this the loop never breaks and the test
    // hangs to timeout instead of asserting cancellation.
    const fetchImpl = (async (_url: any, init?: any) => {
      const signal: AbortSignal = init.signal;
      return new Response(new ReadableStream({
        pull(c) {
          if (signal.aborted) { c.error(new DOMException('Aborted', 'AbortError')); return; }
          c.enqueue(new Uint8Array(4));
          return new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 20);
            signal.addEventListener('abort',
              () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); },
              { once: true });
          });
        },
      }), { status: 200, headers: { 'content-length': '99999' } });
    }) as any;
    const dl = new ModelDownloader(dir, fetchImpl);
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/M-GGUF', quantOpt(false), (p) => events.push(p));
    await new Promise((r) => setTimeout(r, 60));
    dl.cancel(id);
    await expect(dl.wait(id)).rejects.toThrow(/cancel/i);
    expect(events[events.length - 1].state).toBe('cancelled');
    expect(fs.existsSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf.partial'))).toBe(true);
  });

  it('refuses a second concurrent download of the same repo+quant', async () => {
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    expect(() => dl.start('unsloth/M-GGUF', quantOpt(), () => {})).toThrow(/already/i);
    await dl.wait(id);
  });

  // A fetch that drips bytes until the abort signal fires. Copied from the
  // cancel test above for the same reason it exists there: a fake that never
  // resolves cannot be cancelled, and the test hangs to timeout instead of
  // asserting anything.
  const dripUntilAbort = (async (_url: any, init?: any) => {
    const signal: AbortSignal = init.signal;
    return new Response(new ReadableStream({
      pull(c) {
        if (signal.aborted) { c.error(new DOMException('Aborted', 'AbortError')); return; }
        c.enqueue(new Uint8Array(4));
        return new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 20);
          signal.addEventListener('abort',
            () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); },
            { once: true });
        });
      },
    }), { status: 200, headers: { 'content-length': '99999' } });
  }) as typeof fetch;
  const MANIFEST = 'M-UD-Q4_K_XL-00001-of-00002.gguf.download.json';

  it('writes the manifest BEFORE the first byte, and STAMPS it on clean completion', async () => {
    const seen: string[] = [];
    const watching: typeof fetch = (async (url: any, init?: any) => {
      // Record whether the manifest already exists at the moment of each fetch.
      seen.push(fs.existsSync(path.join(dir, MANIFEST)) ? 'yes' : 'no');
      return fetchServing(bodies)(url, init);
    }) as typeof fetch;
    const dl = new ModelDownloader(dir, watching);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id);
    expect(seen).toEqual(['yes', 'yes']);   // present for every part's fetch
    // Was: the manifest was DELETED here. It now survives, carrying the repo
    // and (later) the vision projector a finished model still needs — and
    // completedAt is what marks it finished.
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(typeof m.completedAt).toBe('number');
    expect(m.repo).toBe('unsloth/M-GGUF');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a re-download of a FINISHED model keeps its vision file and is in flight again', async () => {
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    await dl.wait(dl.start('unsloth/M-GGUF', quantOpt(), () => {}));
    // Stand in for the vision projector §E1 will record on the finished download.
    const done = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    done.visionFile = { path: 'mmproj-F16.gguf', size: 900, sha256: null };
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(done));
    // Delete the published parts, the way the user would before fetching again.
    for (const n of Object.keys(bodies)) fs.rmSync(path.join(dir, n));

    await dl.wait(dl.start('unsloth/M-GGUF', quantOpt(), () => {}));
    const after = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(after.visionFile).toEqual({ path: 'mmproj-F16.gguf', size: 900, sha256: null });
    expect(typeof after.completedAt).toBe('number');   // it finished again
  });

  it('a FINISHED download from another repo is not "already partly downloaded"', async () => {
    // The old guard fired on the manifest's mere presence. A stamped manifest
    // means the bytes on disk are WHOLE, so there is no half-fetched file to
    // protect — the user may take the same filename from a different publisher.
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    await dl.wait(dl.start('unsloth/M-GGUF', quantOpt(), () => {}));
    let second = '';
    expect(() => { second = dl.start('bartowski/M-GGUF', quantOpt(), () => {}); }).not.toThrow();
    await dl.wait(second);
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(m.repo).toBe('bartowski/M-GGUF');
    expect(m.visionFile).toBeUndefined();   // and it inherits nothing from unsloth
  });

  it('an untraceable record (repo: null) blocks nothing', async () => {
    // §E3 writes this when it cannot work out where a pre-existing model came
    // from. It is not a rival publisher, so the same-filename guard must ignore it.
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({
      v: 1, repo: null, quant: 'UD-Q4_K_XL', files: quantOpt().files,
      totalSizeBytes: 30, sha256ByFile: {}, startedAt: 1,
    }));
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    let id = '';
    expect(() => { id = dl.start('unsloth/M-GGUF', quantOpt(), () => {}); }).not.toThrow();
    // Awaited, not fire-and-forget: the fixture dir is deleted in afterEach, and
    // a download still writing into it fails as an unhandled rejection.
    await dl.wait(id);
  });

  it('keeps the manifest when the download is cancelled — that is what makes resume possible', async () => {
    const dl = new ModelDownloader(dir, dripUntilAbort);
    const id = dl.start('unsloth/M-GGUF', quantOpt(false), () => {});
    await new Promise((r) => setTimeout(r, 60));
    dl.cancel(id);
    await dl.wait(id).catch(() => {});
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
  });

  it('keeps the manifest when the download errors', async () => {
    const dead: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const dl = new ModelDownloader(dir, dead);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id).catch(() => {});
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
  });

  it('records the repo and the whole file set, so resume needs no network', async () => {
    const dead: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const dl = new ModelDownloader(dir, dead);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id).catch(() => {});
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(m.repo).toBe('unsloth/M-GGUF');
    expect(m.quant).toBe('UD-Q4_K_XL');
    expect(m.files).toEqual(quantOpt().files);
    expect(m.totalSizeBytes).toBe(quantOpt().totalSizeBytes);
  });

  it('refuses to continue a file that a DIFFERENT repo left behind', async () => {
    // Six+ Hugging Face accounts publish byte-identical filenames with different
    // builds (spec §1b). Range-continuing repo A's bytes with repo B's would
    // only be discovered when the integrity check fails at the very end.
    const dead: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const dl = new ModelDownloader(dir, dead);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id).catch(() => {});
    expect(() => dl.start('bartowski/M-GGUF', quantOpt(), () => {}))
      .toThrow(/already partly downloaded from unsloth\/M-GGUF/);
    // The same repo may continue. Awaited (not fire-and-forget) because the
    // dead fetch rejects, and an unawaited rejection here surfaces as an
    // unhandled error that fails the whole run.
    let second = '';
    expect(() => { second = dl.start('unsloth/M-GGUF', quantOpt(), () => {}); }).not.toThrow();
    await dl.wait(second).catch(() => {});
  });
});
