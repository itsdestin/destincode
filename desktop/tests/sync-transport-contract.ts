// desktop/tests/sync-transport-contract.ts
// Contract every SyncTransport implementation must satisfy (spec §15).
// Called from a concrete transport's .test.ts with a factory.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SyncSpace, SyncTransport } from '../src/main/sync-spaces/types';

export interface TransportHarness {
  transport: SyncTransport;
  /** Make a fresh device root attached to the SAME logical remote. */
  makeDeviceSpace(): Promise<SyncSpace>;
  cleanup(): Promise<void>;
}

export function describeTransportContract(name: string, makeHarness: () => Promise<TransportHarness>) {
  describe(`SyncTransport contract: ${name}`, () => {
    // Real transports are I/O-bound (git spawns today, network later) — the
    // slowest contract test does ~6 sequential git round-trips (~8s on Windows).
    // Own a generous timeout here so bare `vitest run` stays green while the
    // global default stays tight for fast unit tests.
    vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

    let h: TransportHarness;
    beforeEach(async () => { h = await makeHarness(); });
    afterEach(async () => { await h.cleanup(); });

    it('init is idempotent and touches nothing outside .youcoded/', async () => {
      const s = await h.makeDeviceSpace();
      await h.transport.init(s);
      await h.transport.init(s);
      const entries = fs.readdirSync(s.root).filter(e => e !== '.youcoded');
      expect(entries).toEqual([]);            // no .git file/dir, no stray files
      expect(fs.existsSync(path.join(s.root, '.git'))).toBe(false);
    });

    it('push then pull round-trips a file to a second device', async () => {
      const a = await h.makeDeviceSpace();
      const b = await h.makeDeviceSpace();
      await h.transport.init(a); await h.transport.init(b);
      fs.mkdirSync(path.join(a.root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(a.root, 'docs', 'notes.md'), 'hello from A\n');
      const push = await h.transport.push(a, 'test change');
      expect(push.pushed).toBe(true);
      const pull = await h.transport.pull(b);
      expect(pull.updated).toBe(true);
      expect(fs.readFileSync(path.join(b.root, 'docs', 'notes.md'), 'utf8')).toBe('hello from A\n');
    });

    it('push with no changes reports pushed:false', async () => {
      const a = await h.makeDeviceSpace();
      await h.transport.init(a);
      const r = await h.transport.push(a, 'noop');
      expect(r.pushed).toBe(false);
    });

    it('divergent edits converge: remote wins canonical, local kept as conflict copy', async () => {
      const a = await h.makeDeviceSpace();
      const b = await h.makeDeviceSpace();
      await h.transport.init(a); await h.transport.init(b);
      fs.writeFileSync(path.join(a.root, 'plan.md'), 'base\n');
      await h.transport.push(a, 'base');
      await h.transport.pull(b);
      // Both edit the same line "offline"
      fs.writeFileSync(path.join(a.root, 'plan.md'), 'A version\n');
      await h.transport.push(a, 'A edit');
      fs.writeFileSync(path.join(b.root, 'plan.md'), 'B version\n');
      const pull = await h.transport.pull(b);   // B pulls A's push → conflict
      expect(pull.conflictCopies.length).toBe(1);
      // Canonical file holds the REMOTE (A) content — convergent rule, spec §8
      expect(fs.readFileSync(path.join(b.root, 'plan.md'), 'utf8')).toBe('A version\n');
      // Conflict copy holds B's content
      const copy = path.join(b.root, pull.conflictCopies[0]);
      expect(fs.readFileSync(copy, 'utf8')).toBe('B version\n');
      // After B pushes, A pulls and converges with NO further conflict
      await h.transport.push(b, 'merge');
      const aPull = await h.transport.pull(a);
      expect(aPull.conflictCopies).toEqual([]);
      expect(fs.readFileSync(path.join(a.root, 'plan.md'), 'utf8')).toBe('A version\n');
      expect(fs.existsSync(path.join(a.root, pull.conflictCopies[0]))).toBe(true);
    });

    it('default ignores are honored (node_modules, .env never travel)', async () => {
      const a = await h.makeDeviceSpace();
      const b = await h.makeDeviceSpace();
      await h.transport.init(a); await h.transport.init(b);
      fs.mkdirSync(path.join(a.root, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(a.root, 'node_modules', 'x', 'i.js'), 'x');
      fs.writeFileSync(path.join(a.root, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(a.root, 'real.md'), 'content');
      await h.transport.push(a, 'with junk');
      await h.transport.pull(b);
      expect(fs.existsSync(path.join(b.root, 'real.md'))).toBe(true);
      expect(fs.existsSync(path.join(b.root, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(b.root, '.env'))).toBe(false);
    });

    it('history lists pushed versions, newest first', async () => {
      const a = await h.makeDeviceSpace();
      await h.transport.init(a);
      fs.writeFileSync(path.join(a.root, 'f.md'), '1');
      await h.transport.push(a, 'first');
      fs.writeFileSync(path.join(a.root, 'f.md'), '2');
      await h.transport.push(a, 'second');
      const hist = await h.transport.history(a, 10);
      expect(hist.length).toBeGreaterThanOrEqual(2);
      expect(hist[0].message).toBe('second');
    });

    it('two devices with pre-existing unrelated content converge on first sync', async () => {
      const a = await h.makeDeviceSpace();
      const b = await h.makeDeviceSpace();
      await h.transport.init(a); await h.transport.init(b);
      // Both devices have content BEFORE ever syncing (e.g. Personal space in use
      // on two machines) — histories are unrelated at first contact.
      fs.writeFileSync(path.join(a.root, 'a-only.md'), 'from A\n');
      fs.writeFileSync(path.join(b.root, 'b-only.md'), 'from B\n');
      fs.writeFileSync(path.join(a.root, 'shared.md'), 'A content\n');
      fs.writeFileSync(path.join(b.root, 'shared.md'), 'B content\n');
      await h.transport.push(a, 'A initial');
      const bPull = await h.transport.pull(b);
      expect(bPull.updated).toBe(true);
      // Non-overlapping files union; overlapping file resolves convergently
      // (remote/A wins canonical, B's content preserved as a conflict copy).
      expect(fs.readFileSync(path.join(b.root, 'a-only.md'), 'utf8')).toBe('from A\n');
      expect(fs.existsSync(path.join(b.root, 'b-only.md'))).toBe(true);
      expect(fs.readFileSync(path.join(b.root, 'shared.md'), 'utf8')).toBe('A content\n');
      expect(bPull.conflictCopies.length).toBe(1);
      // After B pushes, A converges to the identical tree.
      await h.transport.push(b, 'B merge');
      const aPull = await h.transport.pull(a);
      expect(fs.readFileSync(path.join(a.root, 'shared.md'), 'utf8')).toBe('A content\n');
      expect(fs.existsSync(path.join(a.root, 'b-only.md'))).toBe(true);
    });

    it('conflict copies preserve >1MB content byte-for-byte', async () => {
      const a = await h.makeDeviceSpace();
      const b = await h.makeDeviceSpace();
      await h.transport.init(a); await h.transport.init(b);
      fs.writeFileSync(path.join(a.root, 'big.txt'), 'base\n');
      await h.transport.push(a, 'base');
      await h.transport.pull(b);
      const aContent = `A${'x'.repeat(2 * 1024 * 1024)}\n`;
      const bContent = `B${'y'.repeat(2 * 1024 * 1024)}\n`;
      fs.writeFileSync(path.join(a.root, 'big.txt'), aContent);
      await h.transport.push(a, 'A big edit');
      fs.writeFileSync(path.join(b.root, 'big.txt'), bContent);
      const pull = await h.transport.pull(b);
      expect(pull.conflictCopies.length).toBe(1);
      expect(fs.readFileSync(path.join(b.root, 'big.txt'), 'utf8')).toBe(aContent);
      expect(fs.readFileSync(path.join(b.root, pull.conflictCopies[0]), 'utf8')).toBe(bContent);
    });

    it('conflict copies preserve binary content exactly', async () => {
      const a = await h.makeDeviceSpace();
      const b = await h.makeDeviceSpace();
      await h.transport.init(a); await h.transport.init(b);
      const base = Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0, 42]);
      fs.writeFileSync(path.join(a.root, 'data.bin'), base);
      await h.transport.push(a, 'base');
      await h.transport.pull(b);
      const aBytes = Buffer.from([9, 8, 7, 0, 200, 201, 13, 10, 0, 1]);
      const bBytes = Buffer.from([5, 5, 5, 0, 128, 129, 10, 0, 2, 3]);
      fs.writeFileSync(path.join(a.root, 'data.bin'), aBytes);
      await h.transport.push(a, 'A bin edit');
      fs.writeFileSync(path.join(b.root, 'data.bin'), bBytes);
      const pull = await h.transport.pull(b);
      expect(pull.conflictCopies.length).toBe(1);
      expect(Buffer.compare(fs.readFileSync(path.join(b.root, 'data.bin')), aBytes)).toBe(0);
      expect(Buffer.compare(fs.readFileSync(path.join(b.root, pull.conflictCopies[0])), bBytes)).toBe(0);
    });
  });
}
