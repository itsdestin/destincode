/**
 * Canonical form for paths stored in sidecars and used for comparison.
 * Rules per spec § Path canonicalization:
 *   1. Normalize separators to forward slash
 *   2. Lowercase drive letter (Windows)
 *   3. Strip \\?\ prefix
 *   4. Resolve . and ..
 *   5. Internal paths → relative POSIX-style
 *   6. External paths → absolute canonical
 *   7. Strip trailing slashes
 *   8. Unicode NFC normalization
 *
 * Known v1 limitation: a bare `/` input returns `.`. Not a problem in practice
 * because artifact paths are always files (nested), never bare roots. Worth
 * cleaning up in a future task if the canonicalizer ever sees root-only inputs.
 */
export function canonicalize(rawPath: string, projectRoot: string | null): string {
  if (!rawPath) return rawPath;

  // 3. Strip \\?\ prefix
  let p = rawPath.replace(/^\\\\\?\\/, '');

  // 1. Normalize separators
  p = p.replace(/\\/g, '/');

  // 2. Lowercase drive letter
  p = p.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');

  // 8. NFC normalize
  p = p.normalize('NFC');

  // 7. Strip trailing slashes (but keep root '/' or 'c:/')
  if (p.length > 1 && !p.endsWith(':/')) {
    p = p.replace(/\/+$/, '');
  }

  // If we have a project root and this looks like an absolute path inside it,
  // or a relative path, resolve to relative.
  if (projectRoot) {
    const root = canonicalize(projectRoot, null); // canonicalize root absolute
    if (p.startsWith(root + '/')) {
      p = p.slice(root.length + 1);
    }
    // Resolve . and ..
    p = resolveDots(p);
    return p;
  }

  // 4. Resolve . and ..
  p = resolveDots(p);
  return p;
}

function resolveDots(p: string): string {
  const parts = p.split('/');
  const result: string[] = [];
  const isAbsolute = p.startsWith('/');

  for (const part of parts) {
    if (part === '.' || part === '') {
      // Preserve leading / (empty part at start means absolute path)
      if (isAbsolute && result.length === 0) {
        result.push(''); // This will create a leading / when joined
      }
      continue;
    }
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..' && result[result.length - 1] !== '') {
        result.pop();
      } else if (!isAbsolute) {
        result.push('..');
      }
      continue;
    }
    result.push(part);
  }
  return result.join('/') || '.';
}
