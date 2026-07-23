// Pure parsers for git plumbing output. No I/O, no electron imports — every
// function takes strings so the whole module unit-tests with fixtures.
// Spec: docs/active/specs/2026-07-22-git-surface.md section 3.
import type { StructuredPatchHunk } from '../../shared/types';
import type { GitFileCounts, GitLogEntry } from '../../shared/git-types';

export interface PorcelainEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
}

// git status --porcelain=v2 --branch. Line shapes we consume:
//   # branch.head <name>          (name is "(detached)" when detached)
//   1 XY ... <path>               (ordinary change; X=index, Y=worktree, "." = unchanged)
//   2 XY ... <path>\t<origPath>   (rename/copy)
//   ? <path>                      (untracked)
export function parsePorcelainV2(text: string): { branch: string | null; files: PorcelainEntry[] } {
  let branch: string | null = null;
  const files: PorcelainEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      // Fields are space-separated; the path is everything after the 8th field
      // (v2 format is fixed-width up to the path). Renames append "\t<orig>".
      const fieldCount = line.startsWith('2 ') ? 9 : 8;
      const parts = line.split(' ');
      const rawPath = parts.slice(fieldCount).join(' ');
      const p = rawPath.split('\t')[0];
      const staged = xy[0] !== '.';
      const unstaged = xy[1] !== '.';
      const kind =
        xy.includes('R') ? 'renamed'
        : xy.includes('A') ? 'added'
        : xy.includes('D') ? 'deleted'
        : 'modified';
      files.push({ path: p, staged, unstaged, untracked: false, kind });
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), staged: false, unstaged: true, untracked: true, kind: 'untracked' });
    }
  }
  return { branch, files };
}

// git diff --numstat: "<added>\t<removed>\t<path>"; binary files show "-\t-".
export function parseNumstat(text: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p) continue;
    if (a === '-' || r === '-') out.set(p, { added: 0, removed: 0, binary: true });
    else out.set(p, { added: parseInt(a, 10) || 0, removed: parseInt(r, 10) || 0, binary: false });
  }
  return out;
}

// git log --pretty=format:%H%x1f%s%x1f%aI%x1e — unit sep 0x1f, record sep 0x1e.
// Chosen over newline parsing so commit subjects can contain anything.
export function parseLogRecords(text: string): GitLogEntry[] {
  return text
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const [sha, subject, authorDate] = rec.split('\x1f');
      return { sha, shortSha: sha.slice(0, 7), subject: subject ?? '', authorDate: authorDate ?? '' };
    });
}

// Unified diff -> StructuredPatchHunk[] (absolute file line numbers, the shape
// UnifiedDiff.tsx already renders for tool cards). "@@ -a[,b] +c[,d] @@".
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text: string): { hunks: StructuredPatchHunk[]; binary: boolean } {
  const hunks: StructuredPatchHunk[] = [];
  let binary = false;
  let current: StructuredPatchHunk | null = null;
  for (const line of text.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newLines: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (/^Binary files .* differ$/.test(line)) { binary = true; continue; }
    if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      // "\ No newline at end of file" starts with backslash and is skipped.
      current.lines.push(line);
    } else if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      current = null; // next file section header — stop appending to the old hunk
    }
  }
  return { hunks, binary };
}

export function countsFromHunks(hunks: StructuredPatchHunk[]): GitFileCounts {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}

// An untracked file has no diff vs HEAD; render it as one all-additions hunk.
export function synthesizeAddHunk(content: string): StructuredPatchHunk {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing terminator, not a line
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) };
}
