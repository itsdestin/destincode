import { promises as fs } from 'fs';
import { dirname } from 'path';

export interface CasResult {
  committed: boolean;
  actualUpdatedAt: string | null;
}

const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 3000;
const LOCK_STALE_MS = 30_000;

/**
 * Atomic write-then-rename with CAS check, protected by a mkdir-based lock.
 *
 * The lock closes the TOCTOU race where two concurrent writers could both pass
 * the CAS pre-check and then both reach the rename step — the second rename
 * would silently overwrite the first, causing data loss. With the lock, only
 * one writer runs the read+check+write+rename sequence at a time.
 *
 * Lock mechanism: fs.mkdir is atomic on both POSIX and NTFS. The lock directory
 * is created before the critical section and removed in a finally block. A
 * stale-lock heuristic (>30s old) handles crashed processes.
 *
 * @param target Absolute target path
 * @param expectedUpdatedAt The updatedAt value the caller read at the start
 *                          of its mutation. Pass null for "file does not exist
 *                          yet" (creation).
 * @param content New file contents
 * @param extractUpdatedAt Function to pull updatedAt out of a JSON string.
 *                        Optional — when undefined, CAS check is skipped
 *                        (use for non-CAS atomic writes like .gitignore).
 */
export async function casWrite(
  target: string,
  expectedUpdatedAt: string | null,
  content: string,
  extractUpdatedAt?: (json: string) => string
): Promise<CasResult> {
  const lock = target + '.lock';
  await fs.mkdir(dirname(target), { recursive: true });

  // Acquire lock: fs.mkdir is atomic on POSIX and NTFS; fails with EEXIST if
  // another writer already holds it. Retry up to LOCK_MAX_WAIT_MS before
  // giving up with committed: false.
  const start = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock);
      break; // Lock acquired
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // Stale-lock heuristic: if the lock dir is older than LOCK_STALE_MS,
      // the holding process likely crashed — break the lock and retry.
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Ignore stat errors (lock may have just been released)
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        return { committed: false, actualUpdatedAt: null };
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  try {
    // CAS check inside the lock — safe from races now
    if (extractUpdatedAt) {
      try {
        const onDisk = await fs.readFile(target, 'utf8');
        const actual = extractUpdatedAt(onDisk);
        if (actual !== expectedUpdatedAt) {
          return { committed: false, actualUpdatedAt: actual };
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        if (expectedUpdatedAt !== null) {
          return { committed: false, actualUpdatedAt: null };
        }
      }
    }

    // Atomic write inside the lock
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, content, 'utf8');
    const fh = await fs.open(tmp, 'r+');
    await fh.sync();
    await fh.close();
    await fs.rename(tmp, target);

    return { committed: true, actualUpdatedAt: null };
  } finally {
    // Always release the lock, even if an error occurs
    await fs.rm(lock, { recursive: true, force: true });
  }
}
