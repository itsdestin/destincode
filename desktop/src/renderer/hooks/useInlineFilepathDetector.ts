const WHITELIST = new Set([
  'md', 'markdown', 'txt',
  'pdf', 'docx', 'xlsx',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'ts', 'tsx', 'js', 'jsx', 'py', 'css', 'json', 'yaml', 'yml',
]);

// Matches:
//   /abs/path           absolute Unix
//   ~/path              tilde home
//   ./rel  ../rel       explicit-relative
//   C:\path  C:/path    Windows drive
//   dir/file.ext        bare relative (multi-segment with at least one separator)
// All followed by .ext where ext is in the whitelist.
// The bare-relative case (last alternative) requires at least one directory
// segment + separator before the filename, so we don't false-match standalone
// filenames like "plan.md".
const PATH_RE = /(?:^|(?<=\s|[\(\[\{,'"\`>]))((?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/|[\w\-.]+[\\/])[^\s\)\]\},'"\`<:;]*?\.([a-zA-Z0-9]+))(?=$|[\s\)\]\},'"\`<:;])/g;

export interface FilepathMatch {
  path: string;
  start: number;
  end: number;
}

export function detectFilepaths(text: string): FilepathMatch[] {
  const out: FilepathMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    const ext = m[2].toLowerCase();
    if (!WHITELIST.has(ext)) continue;
    out.push({ path: m[1], start: m.index + (m[0].length - m[1].length), end: m.index + m[0].length });
  }
  return out;
}
