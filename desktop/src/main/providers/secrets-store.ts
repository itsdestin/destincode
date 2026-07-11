// API keys at rest: safeStorage(OS keychain)-encrypted blobs in userData —
// NOT in ~/.youcoded (machine-bound ciphertext must never enter a syncable
// home; a restore on another machine couldn't decrypt it anyway — spec §2.1).
// providers.json only ever holds the secretRef pointer; the plaintext key
// never touches disk (pinned by tests/secrets-store.test.ts).
import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { ulid } from 'ulid';
import { mutateFileUnderLock } from '../artifacts/cas-write';

const FILE = 'native-secrets.json';

// Mirrors NativeHome.mutateJson / central-index.ts MAX_RETRIES: each
// mutateFileUnderLock attempt waits up to 3s for the lock, so five attempts
// ride out ~15s of contention before giving up loudly. (NativeHome itself is
// rooted at ~/.youcoded, so it isn't reusable here — this file lives in
// Electron's userData dir on purpose.)
const LOCK_MAX_RETRIES = 5;

export class SecretsStore {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, FILE);
  }

  /** Throws with a user-showable message when the OS keychain is unavailable
   *  (rare Linux setups) — we refuse plaintext fallback by design. */
  private assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Secure key storage is not available on this system, so YouCoded cannot save API keys. (Your OS keychain/libsecret is required.)'
      );
    }
  }

  private read(): Record<string, string> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      // ONLY a missing file reads as "no keys stored". Any other I/O error
      // (EACCES, EIO…) must RETHROW — a transient failure that read as
      // "no keys" would make every saved key look deleted, and has() callers
      // could then prompt the user to re-enter keys that are actually fine.
      // Same narrowing as NativeHome.readJson.
      if (e?.code === 'ENOENT') return {};
      throw e;
    }
    try {
      const parsed = JSON.parse(raw);
      // Corrupt-but-parseable shapes (array, string…) also read as empty —
      // every valid store file is a plain object of ref → base64 blob.
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // Corrupt JSON: the ciphertext is unrecoverable anyway (no backup can
      // decrypt it), so treat as empty and let the next set() rebuild it.
      return {};
    }
  }

  /**
   * Read-modify-write the store file inside cas-write's mkdir lock, with the
   * NativeHome-style retry-then-THROW: a contended write that silently
   * dropped would surface as "saved" in the UI while the key the user just
   * typed evaporated. Failing loudly lets the caller show a real error.
   */
  private async mutate(
    mutateFn: (cur: Record<string, string>) => Record<string, string>
  ): Promise<void> {
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      const ok = await mutateFileUnderLock(this.file, (onDisk) => {
        let cur: Record<string, string> = {};
        if (onDisk !== null) {
          try {
            const parsed = JSON.parse(onDisk);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cur = parsed;
          } catch {
            // Corrupt on disk — rebuild from empty (see read() rationale).
          }
        }
        return JSON.stringify(mutateFn(cur), null, 2);
      });
      if (ok) return;
    }
    throw new Error(
      "Could not save the key — another YouCoded process is holding the store's lock. Try again in a moment."
    );
  }

  /**
   * Encrypt and store a key. Returns the secretRef to persist in
   * providers.json. Pass an existingRef to replace that entry in place
   * (key rotation) — the ref stays stable so pointers don't need rewriting.
   */
  async set(plaintext: string, existingRef?: string): Promise<string> {
    this.assertAvailable();
    const ref = existingRef ?? ulid();
    // Encrypt BEFORE entering the lock — only ciphertext ever flows into the
    // file write, so no code path can accidentally serialize the plaintext.
    const blob = safeStorage.encryptString(plaintext).toString('base64');
    await this.mutate((cur) => ({ ...cur, [ref]: blob }));
    return ref;
  }

  /** Decrypt a stored key. null when the ref is missing or undecryptable
   *  (e.g. the file was copied from another machine — keychain mismatch). */
  async get(ref: string): Promise<string | null> {
    const blob = this.read()[ref];
    if (!blob) return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
  }

  async delete(ref: string): Promise<void> {
    await this.mutate((cur) => {
      const next = { ...cur };
      delete next[ref];
      return next;
    });
  }

  /** Cheap presence check for UI ("key saved" badge) — never decrypts. */
  has(ref: string | undefined): boolean {
    return !!ref && !!this.read()[ref];
  }
}
