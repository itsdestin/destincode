// The promo video's three dev-only fakes. None of this ships: mock-shim.ts is
// the workbench's fake backend. Each `describe` pins one URL/global switch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Workbook } from 'exceljs';

// Same construction as workbench-shim-semantics.test.ts, but the module is
// re-imported per test because the URL switches are read at module scope.
async function shim(search = '') {
  vi.resetModules();
  vi.stubGlobal('location', { search });
  const { createStore } = await import('../src/renderer/dev/workbench/mock-store');
  const { createMockShim } = await import('../src/renderer/dev/workbench/mock-shim');
  return createMockShim(createStore('site')) as any;
}

async function rows(base64: string): Promise<string[][]> {
  const wb = new Workbook();
  // Fix: Node's Buffer.from(...) is typed Buffer<ArrayBuffer>, which exceljs's
  // declared xlsx.load(Buffer) signature rejects under tsconfig.tests.json's
  // stricter Node types (same mismatch XlsxView.tsx works around with `.buffer as any`).
  await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  const out: string[][] = [];
  ws.eachRow((r) => out.push((r.values as unknown[]).slice(1).map((v) => String(v ?? ''))));
  return out;
}

describe('spreadsheet bytes', () => {
  beforeEach(() => { delete (globalThis as any).__workbenchSheet; });

  it('serves an .xlsx for the site session and the "before" sheet is unsorted with no total', async () => {
    const c = await shim('?scenario=site');
    const r = await c.artifacts.readBinary('/home/you/Documents/Q3-sales.xlsx');
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const rs = await rows(r.base64);
    expect(rs[0]).toEqual(['Region', 'Rep', 'Amount', 'Month']);
    const amounts = rs.slice(1).map((x) => Number(x[2]));
    expect(amounts.length).toBe(15);
    expect([...amounts].sort((a, b) => b - a)).not.toEqual(amounts);
    expect(rs.some((x) => x[0] === 'Total')).toBe(false);
  });

  it('serves the "after" sheet when __workbenchSheet is "after": sorted by amount, with a Total row', async () => {
    (globalThis as any).__workbenchSheet = 'after';
    const c = await shim('?scenario=site');
    const r = await c.artifacts.readBinary('/home/you/Documents/Q3-sales.xlsx');
    const rs = await rows(r.base64);
    const body = rs.slice(1, -1);
    const amounts = body.map((x) => Number(x[2]));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(rs.at(-1)?.[0]).toBe('Total');
    expect(Number(rs.at(-1)?.[2])).toBe(amounts.reduce((a, b) => a + b, 0));
  });
});

describe('remote access fake', () => {
  it('is untouched without ?remote= (catch-all answers [])', async () => {
    const c = await shim('');
    expect(await c.remote.getConfig()).toEqual([]);
  });
  it('?remote=setup renders the QR state: enabled, password set, Tailscale url, no clients', async () => {
    const c = await shim('?remote=setup');
    const cfg = await c.remote.getConfig();
    expect(cfg).toMatchObject({ enabled: true, hasPassword: true, clientCount: 0 });
    const ts = await c.remote.detectTailscale();
    expect(ts).toMatchObject({ installed: true, connected: true });
    expect(ts.url).toMatch(/^https?:\/\//);
    expect(await c.remote.getClientList()).toEqual([]);
  });
  it('?remote=connected lists one phone', async () => {
    const c = await shim('?remote=connected');
    const cls = await c.remote.getClientList();
    expect(cls).toHaveLength(1);
    expect(cls[0]).toMatchObject({ id: expect.any(String), ip: expect.any(String), connectedAt: expect.any(Number) });
    expect((await c.remote.getConfig()).clientCount).toBe(1);
    expect(await c.remote.getClientCount()).toBe(1);
  });
});

describe('takeover (lease) fake', () => {
  it('reports no holder without ?lease=', async () => {
    const c = await shim('?scenario=site');
    expect(await c.syncSpaces.leaseQuery('any')).toEqual({ held: false });
  });
  it('?lease=held:Pixel%209 reports another device and lets the takeover succeed', async () => {
    const c = await shim('?scenario=site&lease=held%3APixel%209');
    expect(await c.syncSpaces.leaseQuery('wb-past-1')).toEqual({ held: true, device: 'Pixel 9', self: false, source: 'workbench' });
    expect(await c.syncSpaces.leaseTakeover('wb-past-1')).toEqual({ outcome: 'acquired' });
    expect(await c.syncSpaces.leaseForce('wb-past-1')).toEqual({ ok: true });
  });
});
