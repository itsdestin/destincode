// @vitest-environment jsdom
// pdf.js cannot run in jsdom (getContext('2d') is null and there is no worker),
// so the library is mocked and what we assert is the ORCHESTRATION: one render
// task per page, cancelled before the next one starts on the same canvas.
// Rendering twice into one canvas without cancel() is the pdf.js
// "Cannot use the same canvas during multiple render() operations" error, and
// the pre-existing code never called cancel() anywhere.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const cancel = vi.fn();
const renderFn = vi.fn(() => ({ promise: Promise.resolve(), cancel }));
const getPage = vi.fn(async (n: number) => ({
  pageNumber: n,
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: renderFn,
}));
const destroy = vi.fn(async () => {});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({ numPages: 2, getPage, destroy }),
    destroy: async () => {},
  })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

beforeEach(() => {
  // jsdom has no canvas 2D context, and PdfPage (correctly) bails out when it
  // cannot get one. Stub a context so the ORCHESTRATION under test is reachable;
  // nothing here draws.
  (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => ({}));
  renderFn.mockClear();
  cancel.mockClear();
  getPage.mockClear();
  (window as any).matchMedia = (q: string) => ({
    matches: true, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
  });
  (window as any).claude = {
    artifacts: { readBinary: vi.fn(async () => ({ ok: true, base64: 'AAAA' })) },
  };
});
afterEach(cleanup);

const props = {
  path: 'a.pdf', absolutePath: '/p/a.pdf', content: null, isEditable: false,
} as any;

async function renderPdf() {
  const { PdfView } = await import('../src/renderer/components/artifact-views/PdfView');
  return render(<PdfView {...props} />);
}

describe('pdfScaleCeiling', () => {
  it('caps by area', async () => {
    const { pdfScaleCeiling } = await import('../src/renderer/components/artifact-views/PdfView');
    // 1000x1000 page, 16MP budget -> 4000x4000 -> 4x.
    expect(pdfScaleCeiling(1000, 1000)).toBeCloseTo(4, 2);
  });

  it('caps by a single dimension for a long page, where area alone would not', async () => {
    const { pdfScaleCeiling } = await import('../src/renderer/components/artifact-views/PdfView');
    // 100 x 8000: the 16MP area budget alone would allow ~4.4x, but 16384/8000
    // caps it at ~2.05 — the dimension limit has to win.
    expect(pdfScaleCeiling(100, 8000)).toBeCloseTo(2.048, 2);
  });

  it('never returns less than 1 — this caps ENLARGEMENT, it does not shrink', async () => {
    const { pdfScaleCeiling } = await import('../src/renderer/components/artifact-views/PdfView');
    // A page already past the limit at its base size cannot be helped here: this
    // decides how much BIGGER a page may be drawn, and 1 means "no bigger".
    expect(pdfScaleCeiling(30000, 30000)).toBe(1);
    expect(pdfScaleCeiling(0, 0)).toBe(1);
  });
});

describe('PdfView', () => {
  it('renders every page once at the default scale', async () => {
    await renderPdf();
    await waitFor(() => expect(renderFn).toHaveBeenCalledTimes(2));
  });

  it('offers the zoom controls', async () => {
    await renderPdf();
    await waitFor(() => expect(screen.getByRole('button', { name: /zoom in/i })).toBeTruthy());
  });

  it('re-renders at the new scale and cancels the in-flight task first', async () => {
    await renderPdf();
    await waitFor(() => expect(renderFn).toHaveBeenCalledTimes(2));
    renderFn.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
    await waitFor(() => expect(renderFn).toHaveBeenCalled());
    // The bigger scale must reach pdf.js as a real viewport, not a CSS stretch.
    const viewports = renderFn.mock.calls.map((c: any) => c[0].viewport.width);
    expect(Math.max(...viewports)).toBeGreaterThan(600);
  });

  it('does not re-open the document when only the scale changes', async () => {
    const pdfjs: any = await import('pdfjs-dist');
    await renderPdf();
    await waitFor(() => expect(renderFn).toHaveBeenCalledTimes(2));
    const opens = pdfjs.getDocument.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    // Re-opening would re-download and re-parse the whole file on every click.
    expect(pdfjs.getDocument.mock.calls.length).toBe(opens);
  });
});
