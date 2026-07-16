// Search-provider API keys (Tavily, Exa — spec §3.2 keyed upgrades). The
// PLAINTEXT lives ONLY in SecretsStore (safeStorage, userData); this file
// persists just { backend → secretRef } in ~/.youcoded/search-providers.json —
// same split as providers.json, same NativeHome locking as permission-store.ts.

// Structural interfaces so tests inject fakes and the real classes satisfy them
// without importing them here. List ONLY the methods this store actually calls.
//
// NativeHomeLike: the subset of NativeHome we use. readJson is synchronous and
// returns null for a missing/corrupt file; mutateJson is the locked
// read-modify-write (dev instance + built app share ~/.youcoded/, so every write
// MUST go through it — never a bare write). See src/main/native-home.ts.
export interface NativeHomeLike {
  readJson(rel: string): unknown | null;
  mutateJson(rel: string, mutate: (current: unknown | null) => unknown): Promise<void>;
}

// SecretsLike: the subset of SecretsStore we use. set(plaintext, existingRef?)
// reuses existingRef for in-place rotation (the ref pointer stays stable, so
// this file never needs rewriting on a rotate). See src/main/providers/secrets-store.ts.
export interface SecretsLike {
  set(plaintext: string, existingRef?: string): Promise<string>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
  has(ref: string | undefined): boolean;
}

export type KeyedBackend = 'tavily' | 'exa';

const FILE = 'search-providers.json';
const LABELS: Record<KeyedBackend, string> = { tavily: 'Tavily', exa: 'Exa' };

// On-disk shape: { providers: { tavily?: { secretRef }, exa?: { secretRef } } }.
// Every field is optional because the file is user-syncable and may be
// hand-edited into any shape — the whole store reads it through `.providers?.`
// optional chaining so a garbage file behaves exactly like an empty one.
type SearchFile = { providers?: Partial<Record<KeyedBackend, { secretRef?: unknown }>> };

export class SearchKeyStore {
  constructor(private home: NativeHomeLike, private secrets: SecretsLike) {}

  /**
   * Save (or rotate) a backend's key. Encrypt FIRST via SecretsStore, then
   * persist only the returned secretRef. Reusing the existing ref means a
   * rotation overwrites the same ciphertext entry in place — no orphan blobs,
   * and the pointer we store here never changes.
   */
  async setKey(backend: KeyedBackend, key: string): Promise<void> {
    const existing = await this.refFor(backend);
    // key.trim(): a stray trailing newline/space from a paste would otherwise be
    // encrypted into the key and break the provider auth header silently.
    const secretRef = await this.secrets.set(key.trim(), existing ?? undefined);
    await this.home.mutateJson(FILE, (cur) => {
      // Wrong-shape tolerance: a null/garbage current file falls back to {} and
      // `...data.providers` spreads to {} when providers is missing — so the
      // write heals the shape while preserving any OTHER backend already stored.
      const data = (cur as SearchFile | null) ?? {};
      return { ...data, providers: { ...data.providers, [backend]: { secretRef } } };
    });
  }

  /** Decrypt the stored key for a backend, or null when none is saved. */
  async getKey(backend: KeyedBackend): Promise<string | null> {
    const ref = await this.refFor(backend);
    return ref ? this.secrets.get(ref) : null;
  }

  /**
   * Forget a backend's key. Delete the ciphertext FIRST, then drop the ref
   * entry — ordering it this way means a crash between the two steps leaves a
   * dangling pointer (harmless: getKey/has just read null) rather than an
   * un-deletable orphan blob with no pointer left to find it by.
   */
  async removeKey(backend: KeyedBackend): Promise<void> {
    const ref = await this.refFor(backend);
    if (ref) await this.secrets.delete(ref);
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as SearchFile | null) ?? {};
      const providers = { ...data.providers };
      delete providers[backend];
      return { ...data, providers };
    });
  }

  /**
   * Always both rows (tavily + exa), so the UI can render a fixed list of
   * upgradeable backends regardless of which have keys. hasKey is the cheap
   * presence check (never decrypts).
   */
  async list(): Promise<Array<{ id: KeyedBackend; label: string; hasKey: boolean }>> {
    const data = this.home.readJson(FILE) as SearchFile | null;
    return (Object.keys(LABELS) as KeyedBackend[]).map((id) => {
      const ref = data?.providers?.[id]?.secretRef;
      return {
        id,
        label: LABELS[id],
        hasKey: this.secrets.has(typeof ref === 'string' ? ref : undefined),
      };
    });
  }

  /** The stored secretRef for a backend, or null. Guards on `typeof === 'string'`
   *  so a hand-edited non-string secretRef never reaches SecretsStore. */
  private async refFor(backend: KeyedBackend): Promise<string | null> {
    const data = this.home.readJson(FILE) as SearchFile | null;
    const ref = data?.providers?.[backend]?.secretRef;
    return typeof ref === 'string' ? ref : null;
  }
}
