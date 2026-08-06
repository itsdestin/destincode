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

  // remove() coverage — this is the anti-orphan-ciphertext ordering the
  // whole secret-split design exists to get right (see search-key-store.ts
  // removeKey for the same reasoning). Zero coverage before this pass.

  it('removes the registry row and leaves other entries untouched', async () => {
    // WHY: a wrong/inverted filter predicate in remove() could drop the
    // wrong entry, or none at all — seeding two servers catches either
    // failure mode that a single-entry test would miss.
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await reg.upsert(stdioEntry);
    await reg.upsert({ ...stdioEntry, id: 'other', label: 'Other' });

    await reg.remove('gmail');

    expect(reg.list().map((s) => s.id)).toEqual(['other']);
  });

  it('deletes ciphertext for every secret ref the entry held — both envRefs and headerRefs', async () => {
    // WHY: remove() must iterate BOTH ref maps. An implementation that only
    // handles envRefs (or only headerRefs) would silently orphan the other
    // kind's ciphertext — no registry pointer left, so it's undeletable and
    // resolve() never even reports it since the entry itself is gone.
    const home = fakeHome(); const secrets = fakeSecrets();
    const refA = await secrets.set('env-secret');
    const refB = await secrets.set('header-secret');
    const reg = new McpRegistry(home, secrets);
    await reg.upsert({ ...stdioEntry, envRefs: { GMAIL_TOKEN: refA }, headerRefs: { AUTH: refB } });

    await reg.remove('gmail');

    expect(secrets.m.has(refA)).toBe(false);
    expect(secrets.m.has(refB)).toBe(false);
  });

  it('deletes secret ciphertext BEFORE dropping the registry row (crash-safety ordering)', async () => {
    // WHY: this is the guarantee the secret-split design exists for — a
    // crash between the two steps must leave a dangling secretRef (harmless,
    // resolve() just reports it missing) rather than an orphaned ciphertext
    // blob with no pointer left to find it by. Swapped ordering would pass
    // every other test in this file but fail this one.
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await reg.upsert(stdioEntry, { GMAIL_TOKEN: 'v' });

    const order: string[] = [];
    const origDelete = secrets.delete.bind(secrets);
    secrets.delete = async (ref: string) => { order.push('secrets.delete'); await origDelete(ref); };
    const origMutate = home.mutateJson.bind(home);
    home.mutateJson = async (rel: string, mutate: (cur: unknown | null) => unknown) => {
      order.push('mutateJson'); await origMutate(rel, mutate);
    };

    await reg.remove('gmail');

    expect(order).toEqual(['secrets.delete', 'mutateJson']);
  });

  // Regression test for Finding 3: fromStored() used to spread `raw`
  // wholesale, so a hand-written plaintext `env`/`headers` key sitting in
  // ~/.youcoded/mcp.json (upsert() has no production caller, so hand-editing
  // was the ONLY way to configure a secret-bearing server) survived verbatim
  // into list()'s output and, via resolveEntry's spread, into
  // ResolvedMcpServer.env/.headers — reaching mcp-client's buildTransport and
  // mcp-reconciler's buildRegistryServerConfig. That is exactly the plaintext
  // leak the envRefs/headerRefs split exists to prevent for a file that syncs
  // across devices. Fails on the pre-fix spread (env survives); passes once
  // fromStored builds the entry from known fields only.
  it('a hand-written plaintext env key never reaches list() or resolve()', async () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    // Simulate a hand-edit: write mcp.json directly, bypassing upsert()
    // entirely (which never lets this happen) with a raw `env` field.
    home.files.set('mcp.json', {
      servers: [{
        id: 'gmail', label: 'Gmail', enabled: true,
        transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] },
        origin: { kind: 'user' },
        env: { GMAIL_TOKEN: 'hand-written-plaintext-secret' },
      }],
    });
    const reg = new McpRegistry(home, secrets);

    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect((listed[0] as any).env).toBeUndefined();
    expect(JSON.stringify(listed[0])).not.toContain('hand-written-plaintext-secret');

    const resolved = await reg.resolve('gmail');
    expect(resolved?.env).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain('hand-written-plaintext-secret');
  });

  // Regression tests for Finding 4: assertSafeServerId only ever guarded
  // upsert() (zero production callers) — list()/resolve()/resolveAllEnabled()
  // are what every production consumer (McpManager.acquire(), the Claude Code
  // projection) actually reads, and NEITHER guard applied there before this
  // fix. An id containing "__" would make two different servers' tool names
  // collide (mcp__{server}__{tool}), silently merging their remembered
  // "always allow" grants; a duplicate id would make ensureConnected hand the
  // SECOND entry the FIRST's pooled connection.
  it('an id containing the reserved "__" separator is rejected on the read path, not just on upsert()', () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    home.files.set('mcp.json', {
      servers: [{
        id: 'a__b', label: 'Bad', enabled: true,
        transport: { type: 'stdio', command: 'x' }, origin: { kind: 'user' },
      }],
    });
    const reg = new McpRegistry(home, secrets);
    // Rejected entry reads as absent — never a throw (a malformed hand-edit
    // is a user mistake, not a crash).
    expect(reg.list()).toEqual([]);
  });

  it('duplicate ids in a hand-edited file collapse to the first occurrence', () => {
    const home = fakeHome(); const secrets = fakeSecrets();
    home.files.set('mcp.json', {
      servers: [
        { id: 'gmail', label: 'First', enabled: true, transport: { type: 'stdio', command: 'a' }, origin: { kind: 'user' } },
        { id: 'gmail', label: 'Second', enabled: true, transport: { type: 'stdio', command: 'b' }, origin: { kind: 'user' } },
      ],
    });
    const reg = new McpRegistry(home, secrets);
    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].label).toBe('First');
  });

  it('is a no-op (not a throw) when removing a nonexistent id', async () => {
    // WHY: remove() is invoked from UI flows where the id may already be
    // gone (double-click, stale list refresh) — throwing here would surface
    // as an unhandled promise rejection instead of silently doing nothing.
    const home = fakeHome(); const secrets = fakeSecrets();
    const reg = new McpRegistry(home, secrets);
    await reg.upsert(stdioEntry);

    await expect(reg.remove('does-not-exist')).resolves.toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});
