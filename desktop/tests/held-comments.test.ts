// The author's own record of comments the Worker is holding for review.
// Pins: per-account and per-plugin keying, newest-first with a cap, forgetting
// by id, and that corrupt storage degrades to "nothing held" rather than a throw.
import { describe, it, expect, beforeEach } from 'vitest';
import { readHeldComments, rememberHeldComment, forgetHeldComments } from '../src/renderer/state/held-comments';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

let storage: Storage;
beforeEach(() => { storage = memStorage(); });

describe('held-comments', () => {
  it('remembers per account and per plugin, newest first', () => {
    rememberHeldComment(storage, 'u1', 'p1', { id: 'a', text: 'first', created_at: 1 });
    const list = rememberHeldComment(storage, 'u1', 'p1', { id: 'b', text: 'second', created_at: 2 });
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
    expect(readHeldComments(storage, 'u1', 'p1').map((c) => c.id)).toEqual(['b', 'a']);
    // Another account on the same machine, and another plugin, see nothing.
    expect(readHeldComments(storage, 'u2', 'p1')).toEqual([]);
    expect(readHeldComments(storage, 'u1', 'p2')).toEqual([]);
  });

  it('forgets by id and reports the rest', () => {
    rememberHeldComment(storage, 'u1', 'p1', { id: 'a', text: 'x', created_at: 1 });
    rememberHeldComment(storage, 'u1', 'p1', { id: 'b', text: 'y', created_at: 2 });
    expect(forgetHeldComments(storage, 'u1', 'p1', ['a']).map((c) => c.id)).toEqual(['b']);
    expect(readHeldComments(storage, 'u1', 'p1').map((c) => c.id)).toEqual(['b']);
    expect(forgetHeldComments(storage, 'u1', 'p1', ['b'])).toEqual([]);
    expect(readHeldComments(storage, 'u1', 'p1')).toEqual([]);
  });

  it('caps one plugin at 20, dropping the oldest', () => {
    for (let i = 0; i < 25; i++) rememberHeldComment(storage, 'u1', 'p1', { id: `c${i}`, text: 't', created_at: i });
    const list = readHeldComments(storage, 'u1', 'p1');
    expect(list).toHaveLength(20);
    expect(list[0]!.id).toBe('c24');
    expect(list.map((c) => c.id)).not.toContain('c0');
  });

  it('treats corrupt storage as empty instead of throwing', () => {
    storage.setItem('youcoded:marketplace:held-comments', '{not json');
    expect(readHeldComments(storage, 'u1', 'p1')).toEqual([]);
    storage.setItem('youcoded:marketplace:held-comments', JSON.stringify({ u1: { p1: [{ id: 1 }, { id: 'ok', text: 't', created_at: 3 }] } }));
    expect(readHeldComments(storage, 'u1', 'p1').map((c) => c.id)).toEqual(['ok']);
  });
});
