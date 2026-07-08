const WHITELIST = new Set([
  'md', 'markdown', 'txt',
  'pdf', 'docx', 'xlsx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'ts', 'tsx', 'js', 'jsx', 'py', 'css', 'json', 'yaml', 'yml',
  // Web docs: agent-generated mockups/pages. categorizeArtifact() already
  // treats html/htm/svg as 'document' — whitelist them here too so a path like
  // `C:\…\smiley.html` becomes a clickable pill (opens in the artifact viewer,
  // where the new "Open externally" button launches it in the browser).
  'html', 'htm',
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
// The trailing lookahead also accepts sentence-final punctuation (./!/?) but
// ONLY when followed by whitespace or end-of-text — so "see /docs/plan.md."
// still pills, while `a/b.min.js` isn't cut short at `.min` (the `.` there is
// followed by a letter, not whitespace).
const PATH_RE = /(?:^|(?<=\s|[\(\[\{,'"\`>]))((?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/|[\w\-.]+[\\/])[^\s\)\]\},'"\`<:;]*?\.([a-zA-Z0-9]+))(?=$|[\s\)\]\},'"\`<:;]|[.!?](?:\s|$))/g;

// Protocol-less domains ("see w3.org/intro.html") match the bare-relative
// alternative and would become dead pills. Reject when the FIRST segment looks
// like a hostname ending in a common TLD. Deliberately a short list — a dotted
// directory name like `docs.old/file.md` must keep working.
const DOMAIN_FIRST_SEGMENT_RE = /^(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|co|app|edu|gov|me|us|uk)$/i;

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
    const p = m[1];
    // Bare-relative candidates only: absolute/tilde/drive/dot-relative paths
    // can't be domains.
    if (/^[\w\-.]/.test(p) && !/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('.')) {
      const firstSeg = p.split(/[\\/]/, 1)[0];
      if (DOMAIN_FIRST_SEGMENT_RE.test(firstSeg)) continue;
    }
    out.push({ path: p, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
