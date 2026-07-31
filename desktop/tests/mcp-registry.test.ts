import { describe, it, expect } from 'vitest';
import { McpRegistry, sanitizeServerId } from '../src/main/harness/mcp/mcp-registry';
import type { NativeHomeLike, SecretsLike } from '../src/main/harness/mcp/mcp-registry';
import type { NativeHome } from '../src/main/native-home';
import type { SecretsStore } from '../src/main/providers/secrets-store';

// Interface-drift guard — mirrors search-key-store.test.ts. If NativeHome or
// SecretsStore changes a signature we depend on, tsc fails here.
const _homeDrift: NativeHomeLike = null as unknown as NativeHome;
const _secretsDrift: SecretsLike = null as unknown as SecretsStore;
void _homeDrift; void _secretsDrift;

function fakeHome() {
  const files = new Map<string, unknown>();
  return {
    files,
    readJson(rel: string) { return files.has(rel) ? files.get(rel) : null; },
    async mutateJson(rel: string, mutate: (cur: unknown | null) => unknown) {
      files.set(rel, mutate(files.has(rel) ? files.get(rel)! : null));
    },
  };
}

function fakeSecrets() {
  const m = new Map<string, string>();
  let n = 0;
  return {
    m,
    async set(plaintext: string, existingRef?: string) {
      const ref = existingRef ?? `ref-${++n}`; m.set(ref, plaintext); return ref;
    },
    async get(ref: string) { return m.get(ref) ?? null; },
    async delete(ref: string) { m.delete(ref); },
    has(ref: string | undefined) { return !!ref && m.has(ref); },
  };
}

const stdioEntry = {
  id: 'gmail', label: 'Gmail', enabled: true,
  transport: { type: 'stdio' as const, command: 'npx', args: ['-y', 'gmail-mcp'] },
  origin: { kind: 'user' as const },
};

describe('McpRegistry', () => {
  it('never writes a secret value into the synced registry file', async () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);

    await reg.upsert(stdioEntry, { GMAIL_TOKEN: 'super-secret-value' });

    const onDisk = JSON.stringify(home.files.get('mcp.json'));
    expect(onDisk).not.toContain('super-secret-value');
    expect(onDisk).toContain('secretRef');
    expect(secrets.m.size).toBe(1);
  });

  it('resolves secrets back for use', async () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await reg.upsert(stdioEntry, { GMAIL_TOKEN: 'super-secret-value' });

    const resolved = await reg.resolve('gmail');
    expect(resolved?.env?.GMAIL_TOKEN).toBe('super-secret-value');
    expect(resolved?.missingSecrets).toEqual([]);
  });

  it('reports a missing secret instead of resolving it to undefined', async () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await reg.upsert(stdioEntry, { GMAIL_TOKEN: 'v' });
    secrets.m.clear(); // simulate a synced entry on a second device

    const resolved = await reg.resolve('gmail');
    expect(resolved?.missingSecrets).toEqual(['GMAIL_TOKEN']);
    expect(resolved?.env?.GMAIL_TOKEN).toBeUndefined();
  });

  // NOTE: brief's original title ("rejects a duplicate id rather than silently
  // overwriting a different server") did not match its own assertions — a
  // same-id upsert is an intentional in-place UPDATE (used to edit a server's
  // config/label), not a rejected collision. Renamed to match what the test
  // actually asserts; assertions are verbatim from the brief.
  it('updates in place when the same id is upserted again', async () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await reg.upsert(stdioEntry);
    // Same id, same origin → an update, allowed.
    await reg.upsert({ ...stdioEntry, label: 'Gmail (work)' });
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].label).toBe('Gmail (work)');
  });

  it('treats a garbage file exactly like an empty one', () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    home.files.set('mcp.json', { servers: 'not-an-array' });
    expect(new McpRegistry(home, secrets).list()).toEqual([]);
  });

  it('sanitizes ids to the tool-name charset', () => {
    expect(sanitizeServerId('Google Services!')).toBe('google-services');
    expect(sanitizeServerId('a__b')).toBe('a-b'); // '__' is the tool-name separator
  });

  // Extra beyond the brief's six: upsert() is the one place that actually
  // persists an id, so it's the backstop against a hand-built (not run
  // through sanitizeServerId) id reaching disk and making
  // mcp__{server}__{tool} ambiguous to parse later (Task 5).
  it('rejects an id containing the reserved "__" tool-name separator', async () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await expect(reg.upsert({ ...stdioEntry, id: 'a__b' })).rejects.toThrow(/__/);
    expect(reg.list()).toEqual([]);
  });
});
