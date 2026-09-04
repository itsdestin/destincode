// Paints the picture that follows the cursor while a session pill is being
// dragged between windows on the 'os-drag' tear-off model (Linux/Wayland — see
// session-drag-model.ts).
//
// WHY a canvas and not a React component: on that model the drag is started by
// the MAIN process (`webContents.startDrag`), which takes a NativeImage. There
// is no `dragstart` event, so there is no `setDragImage`, so there is nothing
// that can snapshot a live DOM node. Drawing it directly is the only route that
// needs no extra dependency and — importantly — never puts a throwaway element
// on screen for a frame, which would flash at the exact moment the user is
// looking at the pill they just pulled out.
//
// The DESIGN is the one Destin approved on 2026-09-03, compared against a live
// KDE drag: a small window-shaped card — title bar with the session's real name
// and status dot, body with its last few messages.
//
// NO BORDER AND NO SHADOW — deliberate, do not add them back. He compared five
// edge treatments: rounded corners survive, but a 1px border on the curve and a
// soft outer shadow both fringe, because the compositor composites the drag
// surface's partly-transparent edge pixels differently than a page does. KWin
// draws the real border and shadow the instant the drop creates a window, so
// nothing is lost.
//
// Colors are read from the live document's CSS custom properties, never
// hardcoded, so the card matches whichever of the six themes is active.
import type { SessionStatusColor } from './components/StatusDot';

export interface DragImageMessage {
  role: 'user' | 'assistant';
  text: string;
}

const W = 330;
const TITLE_H = 30;
const BODY_H = 150;
const RADIUS = 14;
const PAD = 12;
const GAP = 8;
const FONT_PX = 11;
const LINE_H = 15;
const BUBBLE_PAD_X = 10;
const BUBBLE_PAD_Y = 6;
const BUBBLE_RADIUS = 10;
const MAX_BUBBLE_W = Math.round((W - PAD * 2) * 0.8);
const MAX_BUBBLE_LINES = 2;

// The strip's own dot palette. Duplicated rather than imported because the
// strip's dot also breathes, and an animation is meaningless in a still image —
// it would be caught at whatever opacity the frame happened to land on, so the
// dot would appear to flicker between drags.
const DOT: Record<SessionStatusColor, string> = {
  green: '#4ade80',
  red: '#f87171',
  amber: '#fbbf24',
  blue: '#60a5fa',
  gray: '#6b7280',
};

function token(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Break text to at most `maxLines` lines of `maxWidth`, ellipsising the last. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    // Anything that did not fit is signalled with an ellipsis rather than
    // silently cut, so a truncated message never reads as a complete one.
    const consumed = lines.join(' ').length;
    if (consumed < text.replace(/\s+/g, ' ').trim().length) {
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines.length ? lines : [''];
}

function ellipsise(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Returns a PNG data URL of the card, or null if the platform cannot give us a
 * 2D context (jsdom in tests, an exotic build). A null just means the drag runs
 * with the platform's default icon — never a thrown error mid-gesture.
 *
 * Drawn at the display's device pixel ratio: the compositor shows the drag
 * surface at 1:1 physical pixels, so painting at DPR is what makes the card the
 * right SIZE on Destin's 1.5x display as well as the right sharpness.
 */
export function paintSessionDragImage(opts: {
  name: string;
  color: SessionStatusColor;
  messages: DragImageMessage[];
  fontFamily?: string;
}): string | null {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const H = TITLE_H + BODY_H;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  const canvasBg = token('--canvas', '#111111');
  const panelBg = token('--panel', '#1a1a1a');
  const insetBg = token('--inset', '#2a2a2a');
  const accent = token('--accent', '#7aa2f7');
  const fg = token('--fg', '#eaeaea');
  const fg2 = token('--fg-2', '#b0b0b0');
  const family = opts.fontFamily
    || 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // Card shape. Everything after this is clipped to it, which is what keeps the
  // corners round without painting a border on the curve.
  roundRect(ctx, 0, 0, W, H, RADIUS);
  ctx.save();
  ctx.clip();

  ctx.fillStyle = canvasBg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = panelBg;
  ctx.fillRect(0, 0, W, TITLE_H);

  // Title bar: status dot + session name.
  ctx.fillStyle = DOT[opts.color] ?? DOT.gray;
  ctx.beginPath();
  ctx.arc(PAD + 4, TITLE_H / 2, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `600 ${FONT_PX}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fg;
  const nameX = PAD + 8 + GAP;
  ctx.fillText(ellipsise(ctx, opts.name, W - nameX - PAD), nameX, TITLE_H / 2 + 0.5);

  // Body. Fixed height regardless of how much history the session has — a
  // picture of a window, not of a transcript.
  ctx.font = `${FONT_PX}px ${family}`;
  if (opts.messages.length === 0) {
    // A session with nothing to show still gets a window-shaped picture rather
    // than an empty rectangle.
    ctx.fillStyle = insetBg;
    const widths = [0.85, 0.6, 0.72];
    widths.forEach((frac, i) => {
      roundRect(ctx, PAD, TITLE_H + PAD + i * (8 + GAP), (W - PAD * 2) * frac, 8, 4);
      ctx.fill();
    });
  } else {
    let y = TITLE_H + PAD;
    for (const msg of opts.messages) {
      const lines = wrap(ctx, msg.text, MAX_BUBBLE_W - BUBBLE_PAD_X * 2, MAX_BUBBLE_LINES);
      const textW = Math.min(
        MAX_BUBBLE_W - BUBBLE_PAD_X * 2,
        Math.max(...lines.map((l) => ctx.measureText(l).width)),
      );
      const bw = textW + BUBBLE_PAD_X * 2;
      const bh = lines.length * LINE_H + BUBBLE_PAD_Y * 2;
      if (y + bh > TITLE_H + BODY_H - PAD + 4) break;
      const mine = msg.role === 'user';
      const x = mine ? W - PAD - bw : PAD;
      ctx.save();
      // The user's bubble is the accent at low opacity, matching the strip's own
      // treatment; globalAlpha rather than a colour literal so it tracks any theme.
      ctx.globalAlpha = mine ? 0.25 : 1;
      ctx.fillStyle = mine ? accent : insetBg;
      roundRect(ctx, x, y, bw, bh, BUBBLE_RADIUS);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = mine ? fg : fg2;
      lines.forEach((line, i) => {
        ctx.fillText(line, x + BUBBLE_PAD_X, y + BUBBLE_PAD_Y + i * LINE_H + LINE_H / 2);
      });
      y += bh + GAP;
    }
  }

  ctx.restore();
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
