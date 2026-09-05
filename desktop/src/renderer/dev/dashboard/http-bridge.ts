// Stands in for Electron's preload bridge when the dashboard runs in a plain
// browser.
//
// ThemeProvider needs exactly five methods out of preload.ts's 54 namespaces, and
// every call site in theme-context.tsx is null-guarded — so anything missing here
// degrades to the four built-in themes rather than crashing.
export function installHttpBridge(): void {
  if ((window as { claude?: unknown }).claude) return; // Never shadow a real bridge.

  (window as unknown as { claude: unknown }).claude = {
    theme: {
      list: async (): Promise<string[]> => (await (await fetch('/api/theme/list')).json()).slugs,
      readFile: async (slug: string): Promise<string> =>
        (await fetch(`/api/theme/read/${encodeURIComponent(slug)}`)).text(),
      // No file watcher behind a browser page — reloading picks up a theme edit.
      onReload: () => () => {},
    },
    appearance: {
      get: async () => (await (await fetch('/api/theme/appearance')).json()).appearance,
      // Deliberately a NO-OP. This writes ~/.claude/youcoded-appearance.json, the
      // same file Destin's LIVE app reads — writing it from a dev tool would reach
      // into his running app, which live-app-safety.md forbids. The dashboard
      // reads which theme is active; it never sets one.
      set: async () => {
        console.info('[dev-dashboard] appearance.set ignored: this page is read-only about themes');
      },
    },
  };
}
