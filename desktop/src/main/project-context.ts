import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverContext, RuleEntry } from './project/context-discovery';
import { cwdToProjectSlug } from './transcript-watcher';
import { RECOGNIZED_INSTRUCTION_FILES, ContextGroup, ContextFile } from '../shared/project-context-types';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

// CC encodes its project dirs with an UPPERCASE drive letter (C--Users-…), but
// YouCoded's canonical project paths can carry a LOWERCASE drive (c:/Users/…).
// Uppercase the drive before slugifying so the memory dir (~/.claude/projects/
// <slug>/memory) resolves; without this the Memory group is silently empty on
// Windows. Windows paths are case-insensitive, so only the drive is normalized.
function ccProjectSlug(projectPath: string): string {
  const driveNormalized = projectPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  return cwdToProjectSlug(driveNormalized);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

// Find recognized instruction files in a directory and (for project scope) its
// .claude subdir. Returns basename → absolutePath for those that exist.
async function findInstructionFiles(dirs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const dir of dirs) {
    for (const name of RECOGNIZED_INSTRUCTION_FILES) {
      const p = path.join(dir, name);
      if (!out[name] && await exists(p)) out[name] = p;
    }
  }
  return out;
}

// Parse a rule .md frontmatter for a globs:/glob: field (first value only).
async function readRules(rulesDir: string): Promise<RuleEntry[]> {
  let files: string[];
  try { files = (await fs.promises.readdir(rulesDir)).filter(f => f.endsWith('.md')); }
  catch { return []; }
  const out: RuleEntry[] = [];
  for (const file of files) {
    const absolutePath = path.join(rulesDir, file);
    let glob: string | undefined;
    try {
      const head = (await fs.promises.readFile(absolutePath, 'utf8')).slice(0, 2000);
      const fm = /^---\s*([\s\S]*?)\s*---/.exec(head)?.[1] ?? '';
      // WHY: anchor to line start (m flag) so a key like `myglobs:` does not
      // shadow the real `globs:`/`glob:` key.
      const g = /^\s*(?:globs?|glob)\s*:\s*(.+)/im.exec(fm)?.[1]?.trim();
      if (g) glob = g.replace(/^['"\[]+|['"\]]+$/g, '').split(',')[0].trim();
    } catch { /* unreadable rule — list it with no glob */ }
    out.push({ file, glob, absolutePath });
  }
  return out;
}

export async function listContext(projectPath: string): Promise<ContextGroup[]> {
  const slug = ccProjectSlug(projectPath);
  const projInstr = await findInstructionFiles([projectPath, path.join(projectPath, '.claude')]);
  const globalInstr = await findInstructionFiles([CLAUDE_DIR]);
  const projRules = await readRules(path.join(projectPath, '.claude', 'rules'));
  const globalRules = await readRules(path.join(CLAUDE_DIR, 'rules'));

  const memoryDir = path.join(CLAUDE_DIR, 'projects', slug, 'memory');
  let memoryFiles: string[] = [];
  const memoryPaths: Record<string, string> = {};
  try {
    memoryFiles = (await fs.promises.readdir(memoryDir)).filter(f => f.endsWith('.md'));
    for (const f of memoryFiles) memoryPaths[f] = path.join(memoryDir, f);
  } catch { /* no memory dir for this project */ }

  const groups = discoverContext({
    projectRoot: projectPath, homeDir: HOME, projectSlug: slug,
    projectInstructionFiles: Object.keys(projInstr), projectInstructionPaths: projInstr,
    projectRules: projRules,
    globalInstructionFiles: Object.keys(globalInstr), globalInstructionPaths: globalInstr,
    globalRules,
    memoryFiles, memoryPaths,
  });

  // Enrich each file with a one-line description + formatted size for the rows
  // (the prototype's ctxRow shows both). Cheap — a handful of files per project.
  await Promise.all(groups.flatMap((g) => g.files).map(enrichContextFile));
  return groups;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// First useful line of a context file → a plain-language description. Prefers a
// frontmatter `description:` (common in rule files), else the first non-empty,
// non-heading body line. Mutates the file in place (it's the discovered object).
function deriveDescription(headRaw: string): string | undefined {
  let head = headRaw;
  const fm = /^---\s*([\s\S]*?)\s*---/.exec(head)?.[1];
  if (fm) {
    const d = /^\s*description\s*:\s*(.+)$/im.exec(fm)?.[1]?.trim();
    if (d) return d.replace(/^['"]|['"]$/g, '').slice(0, 120);
    const close = head.indexOf('---', 3);
    if (close !== -1) head = head.slice(close + 3);
  }
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('<!--')) continue;
    return line.replace(/[*_`>]/g, '').trim().slice(0, 120);
  }
  return undefined;
}

async function enrichContextFile(f: ContextFile): Promise<void> {
  try {
    const stat = await fs.promises.stat(f.absolutePath);
    f.size = formatBytes(stat.size);
  } catch { /* leave size undefined */ }
  try {
    const head = (await fs.promises.readFile(f.absolutePath, 'utf8')).slice(0, 4000);
    f.description = deriveDescription(head);
  } catch { /* leave description undefined */ }
}

// Allow-list guard: only paths that appear in the discovered set for this
// project may be read or written. Prevents arbitrary-path I/O via these IPCs.
async function isAllowed(projectPath: string, absolutePath: string): Promise<boolean> {
  const groups = await listContext(projectPath);
  return groups.some(g => g.files.some(f => f.absolutePath === absolutePath));
}

export async function readContextFile(projectPath: string, absolutePath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!await isAllowed(projectPath, absolutePath)) return { ok: false, error: 'not-a-context-file' };
  try { return { ok: true, content: await fs.promises.readFile(absolutePath, 'utf8') }; }
  catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function writeContextFile(projectPath: string, absolutePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  if (!await isAllowed(projectPath, absolutePath)) return { ok: false, error: 'not-a-context-file' };
  try { await fs.promises.writeFile(absolutePath, content, 'utf8'); return { ok: true }; }
  catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}
