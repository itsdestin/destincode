// Pure CSV/TSV parsing for CsvView — quote-aware (RFC 4180-ish: quoted fields
// may contain the delimiter, newlines, and "" escapes). No I/O, no React, so
// it stays unit-testable.

/** Pick the delimiter by which appears more OUTSIDE quotes on the first line. */
export function detectDelimiter(text: string, ext?: string): string {
  if (ext === 'tsv') return '\t';
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  let commas = 0, tabs = 0, semis = 0, inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ',') commas++;
      else if (ch === '\t') tabs++;
      else if (ch === ';') semis++;
    }
  }
  if (tabs > commas && tabs > semis) return '\t';
  // Semicolon CSVs are common from European-locale Excel exports.
  if (semis > commas) return ';';
  return ',';
}

export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // "" escape
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field.length === 0) { inQuotes = true; i++; continue; }
    if (ch === delim) { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; } // CRLF → handled by the \n branch
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  // Final field/row (no trailing newline). Skip a completely empty trailing row.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}
