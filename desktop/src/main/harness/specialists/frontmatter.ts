// A tolerant, hand-rolled frontmatter parser for specialist definition files.
// WHY hand-rolled: no YAML dependency exists anywhere in desktop/ — every
// config reader in this codebase (settings.json, permissions.json, the skill
// registries) is hand-rolled JSON or a bespoke reader, and pulling in a full
// YAML library for a handful of scalar/list/map shapes would be the first
// dependency of its kind. The parser only needs to understand the small
// subset of YAML that a specialist frontmatter block actually uses.
//
// It is deliberately tolerant: a shape it doesn't recognize becomes a plain
// string rather than throwing, so a typo'd specialist file degrades to a
// loader warning (definition-files.ts) instead of taking down the whole
// catalog read.

export type FrontmatterValue = string | string[] | { nested: true };

export function parseFrontmatter(
  raw: string,
): { data: Record<string, FrontmatterValue>; body: string } | { error: string } {
  // Normalize CRLF/CR up front so every downstream comparison is against a
  // single '\n'-delimited line array — CC and hand-edited files on Windows
  // both show up with \r\n.
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '---') {
    return { error: 'no frontmatter section found (file must start with ---)' };
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return { error: 'frontmatter never closes (no second ---)' };
  }

  const fmLines = lines.slice(1, closeIndex);
  const body = lines.slice(closeIndex + 1).join('\n');

  const data: Record<string, FrontmatterValue> = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (line.trim() === '' || indentOf(line) > 0) {
      // Stray blank/indented line not consumed as a continuation of the
      // previous key (e.g. a blank line between two top-level keys) — skip it.
      i++;
      continue;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rest = line.slice(colonIndex + 1).trim();
    i++;

    // Collect any following indented lines — these are either a block list
    // (`- item`), a nested map, or the body of a folded/literal scalar.
    const indentedLines: string[] = [];
    while (i < fmLines.length && fmLines[i].trim() !== '' && indentOf(fmLines[i]) > 0) {
      indentedLines.push(fmLines[i]);
      i++;
    }

    if (rest === '') {
      if (indentedLines.length === 0) {
        data[key] = '';
      } else if (indentedLines.every((l) => /^\s*-\s/.test(l))) {
        data[key] = indentedLines.map((l) => stripQuotes(l.replace(/^\s*-\s*/, '').trim()));
      } else {
        // We only need to KNOW a nested map is present (e.g. hooks:/skills:)
        // so the loaders can warn — not represent its contents.
        data[key] = { nested: true };
      }
    } else if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
      const joiner = rest.startsWith('|') ? '\n' : ' ';
      data[key] = indentedLines.map((l) => l.trim()).join(joiner);
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s.trim()));
    } else {
      data[key] = stripQuotes(rest);
    }
  }

  return { data, body };
}

function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
