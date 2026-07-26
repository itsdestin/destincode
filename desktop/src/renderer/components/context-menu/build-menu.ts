import { isAndroid, isRemoteMode } from '../../platform';
import { copyText, readText } from './clipboard';
import { editorViewFor } from '../artifact-views/cm/editor-registry';
import type { MenuIconName } from './menu-icons';
import { buildChatReference, buildCodeReference, buildArtifactReference } from './build-reference';
import type { PendingReference } from '../../state/reference-context';

type OnReference = (r: PendingReference) => void;

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
      /** Hover hint, rendered as `title`. Used to explain a DISABLED row.
       *  Native `title=` is the documented tool for plain hover hints;
       *  AnchorTip is for rich click-open info (AnchorTip.tsx:23-25). */
      hint?: string;
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

// The lifted reference card is a static clone, so a still-streaming message
// would freeze mid-sentence inside it. Disabled (not hidden) per Destin
// 2026-07-26 — a vanishing row reads worse than a greyed one.
const STREAMING_HINT = 'Unavailable while Claude is still writing this message';
function isStreaming(el: Element | null): boolean {
  return el?.closest('[data-streaming="true"]') != null;
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

// Cut/Copy/Paste for the CodeMirror edit surface. execCommand does not work
// reliably against CM6's contenteditable (it bypasses CM6's transaction
// model), so the ops go through the EditorView API instead — same UX contract
// as editableMenu above.
function cmEditableMenu(contentEl: HTMLElement): MenuEntry[] {
  const view = editorViewFor(contentEl);
  if (!view) return [];
  const range = view.state.selection.main;
  const hasSelection = !range.empty;
  const selText = hasSelection ? view.state.sliceDoc(range.from, range.to) : '';
  const empty = view.state.doc.length === 0;
  return [
    { type: 'item', id: 'cut', label: 'Cut', icon: 'cut', kbd: mod('X'), disabled: !hasSelection, run: () => {
      void copyText(selText);
      view.dispatch({ changes: { from: range.from, to: range.to, insert: '' } });
      view.focus();
    } },
    { type: 'item', id: 'copy', label: 'Copy', icon: 'copy', kbd: mod('C'), disabled: !hasSelection, run: () => void copyText(selText) },
    { type: 'item', id: 'paste', label: 'Paste', icon: 'paste', kbd: mod('V'), run: async () => {
      const t = await readText();
      if (t) {
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: t },
          selection: { anchor: range.from + t.length },
        });
      }
      view.focus();
    } },
    { type: 'sep' },
    { type: 'item', id: 'select-all', label: 'Select all', icon: 'select-all', kbd: mod('A'), disabled: empty, run: () => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    } },
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

function codeMenu(pre: HTMLElement, target: HTMLElement, onReference: OnReference): MenuEntry[] {
  const code = pre.innerText.replace(/\n+$/, '');
  return [
    {
      type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true,
      disabled: !code || isStreaming(target),
      hint: isStreaming(target) ? STREAMING_HINT : undefined,
      run: () => onReference(buildCodeReference(pre)),
    },
    { type: 'item', id: 'copy-code', label: 'Copy code block', icon: 'code', disabled: !code, run: () => void copyText(code) },
    { type: 'sep' },
    ...textBasics(closestBubble(target)),
  ];
}

function artifactMenu(container: HTMLElement, onReference: OnReference): MenuEntry[] {
  // data-doc-path, not data-artifact-path: the latter is reserved by the deferred
  // image sub-menu roadmap item for an ABSOLUTE path on <img> elements. This one
  // is the project-relative artifact path, which is what reads well in a prompt.
  const path = container.getAttribute('data-doc-path') || '';
  const sel = selectionText().trim();
  const entries: MenuEntry[] = [];
  if (sel && path) {
    entries.push({
      type: 'item',
      id: 'ask',
      label: 'Ask about this',
      icon: 'ask',
      primary: true,
      run: () => {
        const ref = buildArtifactReference(container);
        if (ref) onReference(ref);
      },
    });
  }
  entries.push(...textBasics(container));
  return entries;
}

function textMenu(target: HTMLElement, onReference: OnReference): MenuEntry[] {
  const bubble = closestBubble(target);
  const streaming = isStreaming(target);
  const quote = (selectionText().trim() || bubble?.textContent?.trim()) ?? '';
  const entries: MenuEntry[] = [];
  if (quote) {
    entries.push({
      type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true,
      disabled: streaming,
      hint: streaming ? STREAMING_HINT : undefined,
      run: () => {
        const ref = buildChatReference(bubble, target);
        if (ref) onReference(ref);
      },
    });
  }
  entries.push(...textBasics(bubble));
  return entries;
}

export function buildContextMenu(target: HTMLElement, onReference: OnReference): MenuEntry[] | null {
  // Editable text surfaces (Cut/Copy/Paste/Select all) live outside .chat-scroll:
  // the composer, and the artifact viewer's edit-mode textarea. Electron ships no
  // default context menu, so without this branch right-click in the artifact
  // editor does nothing at all — no cut/copy/paste of any kind.
  const editable = target.closest('.input-bar-textarea, .artifact-edit-textarea');
  if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) {
    return finalize(editableMenu(editable));
  }
  // CodeMirror in EDIT mode: the editable surface is a contenteditable div,
  // not a textarea. The [contenteditable=true] filter matters — read-only CM6
  // also renders .cm-content, and that must fall through to the artifact menu
  // below so "Ask about this" keeps working.
  const cmEditable = target.closest('.cm-content[contenteditable="true"]');
  if (cmEditable instanceof HTMLElement) {
    return finalize(cmEditableMenu(cmEditable));
  }

  // Artifact viewer (SessionDrawer / ProjectView file tab) lives outside
  // .chat-scroll, so it's checked before that gate.
  const artifactViewer = target.closest('[data-artifact-viewer]');
  if (artifactViewer instanceof HTMLElement) return finalize(artifactMenu(artifactViewer, onReference));

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
  if (pre instanceof HTMLElement) return finalize(codeMenu(pre, target, onReference));

  return finalize(textMenu(target, onReference));
}

// Drop a menu with no actionable (enabled) item — e.g. a right-click on empty
// chat gutter — so the host doesn't pop an all-greyed shell.
function finalize(entries: MenuEntry[]): MenuEntry[] | null {
  return entries.some((e) => e.type === 'item' && !e.disabled) ? entries : null;
}
