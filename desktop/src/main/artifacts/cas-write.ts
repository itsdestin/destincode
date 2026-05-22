import { promises as fs } from 'fs';
import { dirname } from 'path';

export interface CasResult {
  committed: boolean;
  actualUpdatedAt: string | null;
}

/**
 * Atomic write-then-rename with CAS check.
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
  // CAS pre-check
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

  // Atomic write
  const tmp = target + '.tmp';
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(tmp, content, 'utf8');
  const fh = await fs.open(tmp, 'r+');
  await fh.sync();
  await fh.close();
  await fs.rename(tmp, target);

  return { committed: true, actualUpdatedAt: null };
}
