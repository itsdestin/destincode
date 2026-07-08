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
/**
 * Acquire the mkdir lock for `target`. Returns false on timeout. Shared by
 * casWrite and mutateFileUnderLock so both use identical lock semantics
 * (atomic mkdir on POSIX + NTFS, 30s stale-lock breaking).
 */
async function acquireLock(lock: string): Promise<boolean> {
  const start = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock);
      return true; // Lock acquired
    } catch (e: any) {
      // EEXIST = normal contention (another writer holds the lock). On Windows
      // NTFS, mkdir racing another writer's in-flight lock REMOVAL surfaces
      // EPERM / EACCES / EBUSY instead (the dir sits in a "delete pending"
      // state until the rmdir completes) — same meaning, so retry rather than
      // throw. Anything else (e.g. ENOENT parent missing) is a real error.
      const contention =
        e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
      if (!contention) throw e;
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
        return false;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/** Atomic tmp-write + fsync + rename onto `target`. */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = target + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
  const fh = await fs.open(tmp, 'r+');
  await fh.sync();
  await fh.close();
  await fs.rename(tmp, target);
}

/**
 * Read-modify-write a file entirely INSIDE the mkdir lock. This is the
 * primitive for files without their own CAS version field (e.g. the central
 * projects index): a caller that reads outside the lock and then writes loses
 * updates when two writers interleave (both read v0, both write, second
 * clobbers the first). Both YouCoded instances (dev + built app) share
 * ~/.claude, so cross-process interleaving is a normal state, not a rarity.
 *
 * @param mutate receives the current on-disk content (null when the file
 *               doesn't exist) and returns the new content, or null to skip
 *               the write.
 * @returns false when the lock couldn't be acquired within the timeout.
 */
export async function mutateFileUnderLock(
  target: string,
  mutate: (onDisk: string | null) => string | null
): Promise<boolean> {
  await fs.mkdir(dirname(target), { recursive: true });
  const lock = target + '.lock';
  if (!(await acquireLock(lock))) return false;
  try {
    let onDisk: string | null = null;
    try {
      onDisk = await fs.readFile(target, 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    const next = mutate(onDisk);
    if (next !== null) await atomicWrite(target, next);
    return true;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

export async function casWrite(
  target: string,
  expectedUpdatedAt: string | null,
  content: string,
  extractUpdatedAt?: (json: string) => string
): Promise<CasResult> {
  const lock = target + '.lock';
  await fs.mkdir(dirname(target), { recursive: true });

  if (!(await acquireLock(lock))) {
    return { committed: false, actualUpdatedAt: null };
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
    await atomicWrite(target, content);

    return { committed: true, actualUpdatedAt: null };
  } finally {
    // Always release the lock, even if an error occurs
    await fs.rm(lock, { recursive: true, force: true });
  }
}
