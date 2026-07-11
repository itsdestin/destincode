// NativeHome — the ONE writer for ~/.youcoded/ (platform roadmap ADR 008).
// All JSON files go through mutateFileUnderLock (dev instance + built app can
// both be running against the same home dir — same cross-process risk the
// artifact central index has, so the mkdir-based file lock is mandatory).
// Session JSONL appends are single-writer by design (only NativeSessionHost
// appends, and exactly one process owns a live session), so a plain
// fs.promises.appendFile is safe and correct there — no lock needed.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mutateFileUnderLock } from './artifacts/cas-write';

export interface SessionFileInfo {
  slug: string;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  path: string;
}

// Mirrors central-index.ts MAX_RETRIES: each mutateFileUnderLock attempt waits
// up to 3s for the lock (cas-write LOCK_MAX_WAIT_MS), so five attempts ride out
// ~15s of contention before giving up loudly.
const LOCK_MAX_RETRIES = 5;

export class NativeHome {
  private readonly dir: string;

  /** homeRoot overridable for tests; production callers pass nothing. */
  constructor(homeRoot: string = os.homedir()) {
    this.dir = path.join(homeRoot, '.youcoded');
  }

  get root(): string {
    return this.dir;
  }

  /**
   * Read a JSON file relative to ~/.youcoded/. Returns null for a missing or
   * unparseable file — reads NEVER create the directory (lazy-creation
   * invariant: ~/.youcoded/ only materializes on the first write).
   */
  readJson(rel: string): unknown | null {
    const p = path.join(this.dir, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e: any) {
      // ONLY a missing file reads as null. Any other I/O error (EACCES, EIO,
      // EISDIR…) must RETHROW: a transient error that read as "file absent"
      // would let an initialize-on-null caller clobber real data on its next
      // write. Same rethrow-non-ENOENT precedent as central-index.ts readIndex.
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt JSON reads as "nothing here yet" — the file exists but holds
      // no usable value, so callers rebuild it (mutateJson does the same).
      return null;
    }
  }

  async writeJson(rel: string, value: unknown): Promise<void> {
    // A plain write is just a mutate that ignores what's on disk — one code
    // path means one locking story.
    await this.mutateJson(rel, () => value);
  }

  /**
   * Read-modify-write inside the file lock. mutate receives the parsed current
   * value (null if absent).
   *
   * WHY the retry-then-THROW (mirrors central-index.ts mutateIndex): a
   * contended write that's silently dropped would surface as "saved" in the UI
   * with nothing actually on disk — for providers.json that means an API key
   * the user just entered evaporates. Failing loudly lets the caller show a
   * real error instead. opts.maxRetries exists only so the contention test can
   * run one ~3s lock-wait cycle instead of five (~15s); production callers
   * never pass it.
   */
  async mutateJson(
    rel: string,
    mutate: (current: unknown | null) => unknown,
    opts?: { maxRetries?: number }
  ): Promise<void> {
    const p = path.join(this.dir, rel);
    // Clamp to ≥1: a 0/negative override would fall straight through the loop
    // and throw "lock held" without ever probing the lock once.
    const maxRetries = Math.max(1, opts?.maxRetries ?? LOCK_MAX_RETRIES);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // mutateFileUnderLock mkdirs the target's parent itself, so the directory
      // is created lazily here on first WRITE — never on read.
      const ok = await mutateFileUnderLock(p, (onDisk) => {
        let current: unknown | null = null;
        if (onDisk !== null) {
          try {
            current = JSON.parse(onDisk);
          } catch {
            // Corrupt file on disk: treat as absent so the mutate can rebuild it.
            current = null;
          }
        }
        return JSON.stringify(mutate(current), null, 2);
      });
      if (ok) return;
    }
    throw new Error(
      `Could not update ${rel} — another YouCoded process is holding its lock. Try again in a moment.`
    );
  }

  private sessionPath(slug: string, sessionId: string): string {
    return path.join(this.dir, 'sessions', slug, `${sessionId}.jsonl`);
  }

  /**
   * Append one JSONL line to sessions/<slug>/<sessionId>.jsonl.
   * WHY no lock: session files are single-writer by design — only the one
   * process that owns the live session ever appends to it, so plain
   * appendFile is correct (and much cheaper than taking the file lock
   * per transcript event).
   */
  async appendSessionLine(slug: string, sessionId: string, obj: unknown): Promise<void> {
    const p = this.sessionPath(slug, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Crash-torn-tail guard: if a previous process died mid-append, the file
    // can end WITHOUT a newline. Appending directly would fuse this record
    // onto the torn fragment — losing BOTH lines to JSON.parse. Writing a
    // newline first bounds the damage to the already-torn record.
    try {
      const st = await fs.promises.stat(p);
      if (st.size > 0) {
        const fh = await fs.promises.open(p, 'r');
        try {
          const buf = Buffer.alloc(1);
          await fh.read(buf, 0, 1, st.size - 1);
          if (buf[0] !== 0x0a /* \n */) await fs.promises.appendFile(p, '\n', 'utf8');
        } finally {
          await fh.close();
        }
      }
    } catch (e: any) {
      // ENOENT = first line of a new session file, nothing to guard.
      if (e?.code !== 'ENOENT') throw e;
    }
    await fs.promises.appendFile(p, JSON.stringify(obj) + '\n', 'utf8');
  }

  readSessionLines(slug: string, sessionId: string): unknown[] {
    const p = this.sessionPath(slug, sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return []; // no such session yet — empty transcript, not an error
    }
    const out: unknown[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Unparseable line — skipped PERMANENTLY (a crash-torn record stays
        // torn on disk; appendSessionLine's tail guard only protects the NEXT
        // record from fusing into it). A mid-live-append read may also see a
        // torn tail transiently; that one heals on the next read.
      }
    }
    return out;
  }

  /** Enumerate every sessions/<slug>/<id>.jsonl with stat info (for browse/resume UIs). */
  listSessionFiles(): SessionFileInfo[] {
    const base = path.join(this.dir, 'sessions');
    const out: SessionFileInfo[] = [];
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(base);
    } catch {
      return out; // no sessions dir yet — nothing to list
    }
    for (const slug of slugs) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(base, slug));
      } catch {
        continue; // stray file (not a dir) or deleted mid-scan — skip
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(base, slug, f);
        try {
          const st = fs.statSync(full);
          out.push({
            slug,
            sessionId: f.slice(0, -'.jsonl'.length),
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            path: full,
          });
        } catch {
          // deleted between readdir and stat — skip
        }
      }
    }
    return out;
  }
}
