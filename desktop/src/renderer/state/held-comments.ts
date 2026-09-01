// Held comments — the author's own record of comments the marketplace is
// holding for review.
//
// WHY this exists: a comment the classifier flags is stored hidden and is never
// returned by the public thread. The author saw "Posted. It's held for review."
// once, and then nothing, forever — reopen the page and the comment is simply
// gone, which reads as "it was never posted" or "it was deleted". The Worker
// does carry the row (GET /auth/export lists the owner's comments with
// `hidden`), but that endpoint is rate-limited to 5 calls an hour and returns
// the whole account, so it cannot back a page that opens dozens of times a day.
// A per-account list in this device's storage is enough to keep the promise
// the toast made: you can still see what you wrote, marked as held.
//
// Limits, stated so nobody mistakes this for the server's truth: it is this
// device only (another device never learns the comment exists), and it says
// "held", never "approved" — if the comment ever appears in the public list,
// CommentList drops the local copy (`forgetHeldComments`) rather than showing
// it twice. Storage failures are swallowed: the worst case is the old
// behaviour (toast only), never a broken page.

export interface HeldComment {
  id: string;
  text: string;
  /** Unix seconds, taken when the post returned — the Worker's own stamp is
   *  not in the POST response. */
  created_at: number;
}

const KEY = 'youcoded:marketplace:held-comments';
/** Per plugin, per account. Anyone writing more than this many held comments
 *  on one page is not who this list is for; the oldest fall off. */
const MAX_PER_PLUGIN = 20;

/** userId → pluginId → newest-first list. Keyed by account so two people
 *  sharing one machine never see each other's held comments. */
type HeldStore = Record<string, Record<string, HeldComment[]>>;

function readStore(storage: Storage): HeldStore {
  try {
    const raw = storage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as HeldStore) : {};
  } catch {
    return {};
  }
}

function writeStore(storage: Storage, store: HeldStore): void {
  try { storage.setItem(KEY, JSON.stringify(store)); } catch { /* quota / private mode — keep in memory only */ }
}

function listOf(store: HeldStore, userId: string, pluginId: string): HeldComment[] {
  const list = store[userId]?.[pluginId];
  return Array.isArray(list)
    ? list.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && typeof c.created_at === 'number')
    : [];
}

export function readHeldComments(storage: Storage, userId: string, pluginId: string): HeldComment[] {
  return listOf(readStore(storage), userId, pluginId);
}

/** Record one held comment; returns the plugin's new list (newest first). */
export function rememberHeldComment(storage: Storage, userId: string, pluginId: string, comment: HeldComment): HeldComment[] {
  const store = readStore(storage);
  const current = listOf(store, userId, pluginId).filter((c) => c.id !== comment.id);
  const next = [comment, ...current].slice(0, MAX_PER_PLUGIN);
  (store[userId] ??= {})[pluginId] = next;
  writeStore(storage, store);
  return next;
}

/** Drop held comments by id (they showed up in the public list, so the local
 *  copy would be a duplicate); returns the plugin's new list. */
export function forgetHeldComments(storage: Storage, userId: string, pluginId: string, ids: string[]): HeldComment[] {
  const store = readStore(storage);
  const current = listOf(store, userId, pluginId);
  const next = current.filter((c) => !ids.includes(c.id));
  if (next.length === current.length) return current;
  if (next.length === 0) delete store[userId]?.[pluginId];
  else (store[userId] ??= {})[pluginId] = next;
  writeStore(storage, store);
  return next;
}
