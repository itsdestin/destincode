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
