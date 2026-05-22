const WHITELIST = new Set([
  'md', 'markdown', 'txt',
  'pdf', 'docx', 'xlsx',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'ts', 'tsx', 'js', 'jsx', 'py', 'css', 'json', 'yaml', 'yml',
]);

// Matches:
//   /abs/path  ~/path  ./rel  ../rel  C:\path  C:/path  rel/path (with slash)
//   followed by .ext where ext is in the whitelist
const PATH_RE = /(?:^|(?<=\s|[\(\[\{,'"\`>]))((?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)[^\s\)\]\},'"\`<:;]*?\.([a-zA-Z0-9]+))(?=$|[\s\)\]\},'"\`<:;])/g;

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
