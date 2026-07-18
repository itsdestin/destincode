import { isAndroid, isRemoteMode } from '../../platform';
import { copyText, readText } from './clipboard';
import type { MenuIconName } from './menu-icons';

// Builds the chat right-click menu for a given DOM target. Pure inspection of
// the DOM + current selection → a list of entries; the host owns positioning,
// open/close, and rendering. Returns null when the target isn't a surface we
// own (or has nothing actionable), so the host leaves the event alone.

export type MenuEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      icon: MenuIconName;
      kbd?: string;
      primary?: boolean;
      disabled?: boolean;
      run: () => void | Promise<void>;
    }
  | { type: 'sep' };

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
// Reveal-in-folder / open-in-OS only do anything on the Electron desktop; on
// Android and remote-browser the shell IPC is a no-op, so we hide those items.
const isDesktop = () => !isAndroid() && !isRemoteMode();

// window.claude is the shared IPC surface (preload on desktop, remote-shim on
// Android/remote). Typed loosely here to avoid coupling to the ambient global.
const shell = () => (window as { claude?: { shell?: any } }).claude?.shell;

function selectionText(): string {
  return window.getSelection()?.toString() ?? '';
}

function closestBubble(el: Element): Element | null {
  return el.closest('.assistant-bubble, .user-bubble');
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

function selectElementContents(el: Element): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

// "Ask about this" drops a quoted reference + follow-up scaffold into the
// composer (InputBar listens for this CustomEvent — see InputBar.tsx). Simple v1
// per Destin (2026-07-17): plain prompt text, no new plumbing. The caret lands
// right after the scaffold so any existing draft becomes the follow-up.
function askAboutThis(text: string): void {
  window.dispatchEvent(new CustomEvent('youcoded:compose-insert', { detail: { text } }));
}

function scaffold(lead: string, body: string, fenced: boolean): string {
  const quoted = fenced ? '```\n' + body + '\n```' : `"${body}"`;
  return `${lead}\n${quoted}\n\nThe user has a follow-up: `;
}

// Copy + Select all — shared tail for every read-only chat menu.
function textBasics(bubble: Element | null): MenuEntry[] {
  const sel = selectionText();
  return [
    {
      type: 'item',
      id: 'copy',
      label: 'Copy',
      icon: 'copy',
      kbd: mod('C'),
      disabled: !sel && !bubble,
      run: () => void copyText(sel || (bubble?.textContent ?? '')),
    },
    {
      type: 'item',
      id: 'select-all',
      label: 'Select all',
      icon: 'select-all',
      kbd: mod('A'),
      disabled: !bubble,
      run: () => {
        if (bubble) selectElementContents(bubble);
      },
    },
  ];
}

function editableMenu(el: HTMLTextAreaElement | HTMLInputElement): MenuEntry[] {
  // Capture the selection NOW (at right-click), because auto-focusing the menu
  // blurs the textarea; we restore this range before each op so cut/copy/paste
  // act on what the user actually had selected.
  const selStart = el.selectionStart ?? 0;
  const selEnd = el.selectionEnd ?? 0;
  const hasSelection = selStart !== selEnd;
  const empty = (el.value ?? '').length === 0;
  const restore = () => {
    el.focus();
    el.setSelectionRange(selStart, selEnd);
  };
  return [
    // execCommand cut/paste fire the native 'input' event, so React's controlled
    // onChange stays in sync — a manual value set would not.
    { type: 'item', id: 'cut', label: 'Cut', icon: 'cut', kbd: mod('X'), disabled: !hasSelection, run: () => { restore(); document.execCommand('cut'); } },
    { type: 'item', id: 'copy', label: 'Copy', icon: 'copy', kbd: mod('C'), disabled: !hasSelection, run: () => { restore(); document.execCommand('copy'); } },
    { type: 'item', id: 'paste', label: 'Paste', icon: 'paste', kbd: mod('V'), run: async () => { restore(); const t = await readText(); if (t) document.execCommand('insertText', false, t); } },
    { type: 'sep' },
    { type: 'item', id: 'select-all', label: 'Select all', icon: 'select-all', kbd: mod('A'), disabled: empty, run: () => { el.focus(); el.select(); } },
  ];
}

function filePillMenu(el: HTMLElement): MenuEntry[] {
  const abs = el.getAttribute('data-file-path') || '';
  const name = baseName(abs);
  const entries: MenuEntry[] = [];
  if (isDesktop()) {
    entries.push(
      { type: 'item', id: 'open-file', label: 'Open file', icon: 'open', primary: true, run: () => shell()?.openPath(abs) },
      { type: 'item', id: 'reveal', label: 'View in folder', icon: 'folder', run: () => shell()?.showItemInFolder(abs) },
      { type: 'sep' },
    );
  }
  entries.push(
    { type: 'item', id: 'copy-name', label: 'Copy file name', icon: 'copy', run: () => void copyText(name) },
    { type: 'item', id: 'copy-path', label: 'Copy as path', icon: 'path', run: () => void copyText(abs) },
  );
  return entries;
}

function linkMenu(a: HTMLAnchorElement, target: HTMLElement): MenuEntry[] {
  const href = a.href || a.getAttribute('href') || '';
  return [
    { type: 'item', id: 'open-link', label: 'Open link', icon: 'open', primary: true, disabled: !href, run: () => { if (href) shell()?.openExternal(href); } },
    { type: 'item', id: 'copy-link', label: 'Copy link address', icon: 'link', disabled: !href, run: () => void copyText(href) },
    { type: 'sep' },
    ...textBasics(closestBubble(target)),
  ];
}

function codeMenu(pre: HTMLElement, target: HTMLElement): MenuEntry[] {
  const code = pre.innerText.replace(/\n+$/, '');
  return [
    { type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true, disabled: !code, run: () => askAboutThis(scaffold('Earlier, you shared this code:', code, true)) },
    { type: 'item', id: 'copy-code', label: 'Copy code block', icon: 'code', disabled: !code, run: () => void copyText(code) },
    { type: 'sep' },
    ...textBasics(closestBubble(target)),
  ];
}

function textMenu(target: HTMLElement): MenuEntry[] {
  const bubble = closestBubble(target);
  const quote = (selectionText().trim() || bubble?.textContent?.trim()) ?? '';
  // "you said" reads right for an assistant message; flip it for the user's own
  // bubble, and stay neutral if we can't tell.
  const lead = bubble?.classList.contains('assistant-bubble')
    ? 'In an earlier message, you said:'
    : bubble?.classList.contains('user-bubble')
      ? 'Earlier I wrote:'
      : 'Regarding this:';
  const entries: MenuEntry[] = [];
  if (quote) {
    entries.push({ type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true, run: () => askAboutThis(scaffold(lead, quote, false)) });
  }
  entries.push(...textBasics(bubble));
  return entries;
}

export function buildContextMenu(target: HTMLElement): MenuEntry[] | null {
  // The editable composer (Cut/Copy/Paste/Select all) lives outside .chat-scroll.
  const composer = target.closest('.input-bar-textarea');
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return finalize(editableMenu(composer));
  }

  // Everything else is scoped to chat content — never hijack the terminal, the
  // settings panels, or other chrome.
  if (!target.closest('.chat-scroll')) return null;

  const filePill = target.closest('[data-file-path]');
  if (filePill instanceof HTMLElement && filePill.getAttribute('data-file-path')) {
    return finalize(filePillMenu(filePill));
  }
  const link = target.closest('a[href]');
  if (link instanceof HTMLAnchorElement) return finalize(linkMenu(link, target));

  const pre = target.closest('pre');
  if (pre instanceof HTMLElement) return finalize(codeMenu(pre, target));

  return finalize(textMenu(target));
}

// Drop a menu with no actionable (enabled) item — e.g. a right-click on empty
// chat gutter — so the host doesn't pop an all-greyed shell.
function finalize(entries: MenuEntry[]): MenuEntry[] | null {
  return entries.some((e) => e.type === 'item' && !e.disabled) ? entries : null;
}
