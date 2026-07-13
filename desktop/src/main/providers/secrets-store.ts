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

  /**
   * Parse store-file contents into the ref → base64-blob map. Corrupt JSON
   * and corrupt-but-parseable shapes (array, string…) read as empty — the
   * ciphertext is unrecoverable anyway (it's bound to this machine's
   * keychain; no backup can decrypt it), so the next set() rebuilds the file.
   * Single parser shared by read() and mutate() so their tolerance can't drift.
   */
  private parseStore(raw: string | null): Record<string, string> {
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
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
    return this.parseStore(raw);
  }

  /**
   * Read-modify-write the store file inside cas-write's mkdir lock, with the
   * NativeHome-style retry-then-THROW: a contended write that silently
   * dropped would surface as "saved" in the UI while the key the user just
   * typed evaporated. Failing loudly lets the caller show a real error.
   * opts.maxRetries is TEST-ONLY (mirrors NativeHome.mutateJson): it lets the
   * lock-contention test run one ~3s lock-wait cycle instead of five (~15s);
   * production callers never pass it.
   */
  private async mutate(
    mutateFn: (cur: Record<string, string>) => Record<string, string>,
    opts?: { maxRetries?: number }
  ): Promise<void> {
    // Clamp to ≥1: a 0/negative override would fall straight through the loop
    // and throw "lock held" without ever probing the lock once.
    const maxRetries = Math.max(1, opts?.maxRetries ?? LOCK_MAX_RETRIES);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const ok = await mutateFileUnderLock(this.file, (onDisk) =>
        JSON.stringify(mutateFn(this.parseStore(onDisk)), null, 2)
      );
      if (ok) return;
    }
    // Operation-neutral copy: both set() AND delete() route through here, so
    // "could not save the key" would read wrong to a user REMOVING one.
    throw new Error(
      "Could not update saved API keys — another YouCoded process is holding the store's lock. Try again in a moment."
    );
  }

  /**
   * Encrypt and store a key. Returns the secretRef to persist in
   * providers.json. Pass an existingRef to replace that entry in place
   * (key rotation) — the ref stays stable so pointers don't need rewriting.
   * opts.maxRetries is TEST-ONLY (see mutate()).
   */
  async set(
    plaintext: string,
    existingRef?: string,
    opts?: { maxRetries?: number }
  ): Promise<string> {
    this.assertAvailable();
    const ref = existingRef ?? ulid();
    // Encrypt BEFORE entering the lock — only ciphertext ever flows into the
    // file write, so no code path can accidentally serialize the plaintext.
    const blob = safeStorage.encryptString(plaintext).toString('base64');
    await this.mutate((cur) => ({ ...cur, [ref]: blob }), opts);
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

  /** opts.maxRetries is TEST-ONLY (see mutate()). */
  async delete(ref: string, opts?: { maxRetries?: number }): Promise<void> {
    await this.mutate((cur) => {
      const next = { ...cur };
      delete next[ref];
      return next;
    }, opts);
  }

  /** Cheap presence check for UI ("key saved" badge) — never decrypts. */
  has(ref: string | undefined): boolean {
    return !!ref && !!this.read()[ref];
  }
}
