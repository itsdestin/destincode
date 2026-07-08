// Shared visual language for the spreadsheet-style viewers (XlsxView, CsvView).
// The "paper" stays LIGHT (cell fills + dark cell text assume a light sheet,
// like real Excel) but takes on a subtle tint from the active theme's accent
// hue instead of pure white — so it reads as part of the themed app, not a
// stark white rectangle. color-mix is already used elsewhere in the app's CSS
// and is supported in Electron + the Android WebView.
export const PAPER = 'color-mix(in srgb, var(--accent) 4%, #ffffff)';      // cell area
export const GUTTER_BG = 'color-mix(in srgb, var(--accent) 13%, #ffffff)'; // A/B/C + row gutters
export const FBAR_BG = 'color-mix(in srgb, var(--accent) 7%, #ffffff)';    // formula bar
export const TAB_BG = 'color-mix(in srgb, var(--accent) 10%, #ffffff)';    // sheet-tab strip
export const GRID = 'color-mix(in srgb, var(--accent) 16%, #d2d2d2)';      // gridlines (faintly tinted)
export const GUTTER_FG = '#5f5f5f';
export const SEL = '#217346'; // Excel green — kept for guaranteed-visible cell selection
// Truncation-note strip ("Showing first N rows…") — amber warning text on a pale
// amber field, shared so CsvView and XlsxView can't drift apart.
export const NOTE_FG = '#8a6d3b';
export const NOTE_BG = '#fcf8e3';
