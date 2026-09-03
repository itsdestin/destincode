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
  await wb.xlsx.load(Buffer.from(base64, 'base64'));
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
