// Artifact categorization — splits files into two buckets:
//   'document' — things a non-developer can open and understand
//                (Markdown, Word, Excel, PDF, images, HTML mockups, etc.)
//   'code'     — code, configs, shell scripts, logs, everything else
// Used by the "Hide code & configs" toggle in Session Drawer + Project View.
// Unknown extensions default to 'code' (conservative — keep the category
// labeled "Documents and Mockups" reserved for things we're confident about).

export type ArtifactCategory = 'document' | 'code';

// Extensions a non-technical user would expect to read directly.
// Lowercase, no leading dot. Edge calls:
//   - html/htm → 'document' (agent-generated mockups; we treat them as previewable)
//   - svg → 'document' (renders as image even though it's XML)
//   - csv → 'document' (tabular data, readable like a spreadsheet)
//   - json/yaml/toml → 'code' (config-shaped by default; per-file override is v2)
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // Prose
  'md', 'markdown', 'txt', 'rtf',
  // Office
  'doc', 'docx', 'xls', 'xlsx', 'csv', 'tsv', 'ppt', 'pptx',
  // Print
  'pdf',
  // Images (rendered)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
  // Mockups
  'html', 'htm',
]);

export function categorizeArtifact(path: string): ArtifactCategory {
  if (!path) return 'code';
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = filename.lastIndexOf('.');
  // No extension, or leading-dot dotfile (e.g. .gitignore) → code
  if (lastDot <= 0) return 'code';
  const ext = filename.slice(lastDot + 1).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext) ? 'document' : 'code';
}

// ── Fine-grained type groups ─────────────────────────────────────────────────
// A finer split of the binary categorizer, used by the Project View type filter
// and card labels. Every path lands in exactly ONE group, so filtering by each
// group in turn always covers the whole list:
//   'image'    — rendered image formats
//   'sheet'    — tabular data (spreadsheets, csv)
//   'document' — remaining prose / office / mockup formats
//   'code'     — everything categorizeArtifact calls code (source, configs, logs)
export type FileTypeGroup = 'document' | 'image' | 'sheet' | 'code';

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
]);
const SHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xls', 'xlsx', 'csv', 'tsv']);

export function fileTypeGroup(path: string): FileTypeGroup {
  if (categorizeArtifact(path) === 'code') return 'code';
  // Document per the binary categorizer — refine by extension.
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (SHEET_EXTENSIONS.has(ext)) return 'sheet';
  return 'document';
}

// Human label for a file card's second line ("Document" / "Image" / …).
const GROUP_LABELS: Record<FileTypeGroup, string> = {
  document: 'Document', image: 'Image', sheet: 'Spreadsheet', code: 'Code',
};
export function fileTypeLabel(path: string): string {
  return GROUP_LABELS[fileTypeGroup(path)];
}

// ── File kinds for tiles and chips ───────────────────────────────────────────
// A finer split again, for surfaces that show a per-file glyph and decide what
// preview a tile can cheaply render (the composer's attachment cards, first).
// Layers pdf / audio / video / archive / text / markdown / unknown buckets over
// fileTypeGroup(), whose 'code' group is really "everything else" — a `.dat`
// sensor log is not code, and a tile that calls it code would lie. Moved here
// from the attachment-chip mock-up when design C shipped (2026-08-27) so the
// composer, the mock-up page, and any future tile share ONE mapping.
export type FileKind =
  | 'image' | 'sheet' | 'document' | 'code' | 'text' | 'markdown'
  | 'pdf' | 'audio' | 'video' | 'archive' | 'unknown';

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi']);
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar']);
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown']);
const PLAIN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'text', 'log']);
// Extensions we are confident hold source/config text. Anything else that
// lands in fileTypeGroup's 'code' bucket is 'unknown' for tile purposes.
const KNOWN_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'kt', 'kts', 'java', 'rs', 'go', 'rb', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'bat', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'css', 'scss', 'less', 'sql', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'xml', 'lua', 'php',
  'gradle', 'properties',
]);

/** Lowercase extension without the dot; '' for none or a leading-dot dotfile. */
export function fileExtension(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
}

export function fileKind(path: string): FileKind {
  const ext = fileExtension(path);
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) return 'text';
  const group = fileTypeGroup(path);
  if (group === 'code') return KNOWN_CODE_EXTENSIONS.has(ext) ? 'code' : 'unknown';
  return group;
}

// What a tile can show for a file without opening a viewer:
//   'image'    — the picture itself
//   'markdown' — the first bytes, RENDERED (headings, bold, lists — never a raw
//                `##`; Destin's rule, 2026-08-27)
//   'text'     — the first bytes in a small mono block (plain text, code, csv)
//   'glyph'    — the big type icon + extension in caps (pdf, office, media, …)
export type PreviewKind = 'image' | 'markdown' | 'text' | 'glyph';

const IMAGE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

export function previewKind(path: string): PreviewKind {
  const kind = fileKind(path);
  const ext = fileExtension(path);
  // Only the formats today's composer chip already thumbnails (its
  // isImagePath set). svg/ico/avif stay on the glyph: an <img> from an
  // arbitrary path can't be trusted to decode them, and a broken picture is
  // worse than an honest icon.
  if (kind === 'image') return IMAGE_PREVIEW_EXTENSIONS.has(ext) ? 'image' : 'glyph';
  if (kind === 'markdown') return 'markdown';
  if (kind === 'text' || kind === 'code') return 'text';
  // csv/tsv are tabular TEXT — the first rows are a real preview; xls(x) is not.
  if (kind === 'sheet' && (ext === 'csv' || ext === 'tsv')) return 'text';
  return 'glyph';
}
