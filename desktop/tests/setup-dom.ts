// Per-test-file DOM setup (vitest `setupFiles`), jsdom only.
//
// jsdom ships no ResizeObserver. Several components observe their own size --
// most notably useScrollFade, which every <Dialog> now runs because Dialog owns
// its scroll region. Before this, each test that happened to render such a
// component hand-rolled the same three-method stub; four of them already did,
// and D1's dialog migration would have required it in a dozen more.
//
// Stubbing it here instead means a test fails for a reason about the component,
// not about a missing browser API. The stub is inert on purpose: no test in this
// suite asserts on resize-driven behaviour, and a fake that fired callbacks
// would invent layout events jsdom cannot actually produce.
if (typeof globalThis.window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  (globalThis.window as any).ResizeObserver = ResizeObserverStub;
}
