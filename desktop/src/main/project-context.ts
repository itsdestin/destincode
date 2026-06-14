import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverContext, RuleEntry } from './project/context-discovery';
import { cwdToProjectSlug } from './transcript-watcher';
import { RECOGNIZED_INSTRUCTION_FILES, ContextGroup } from '../shared/project-context-types';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

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
      const g = /(?:globs?|glob)\s*:\s*(.+)/i.exec(fm)?.[1]?.trim();
      if (g) glob = g.replace(/^['"\[]+|['"\]]+$/g, '').split(',')[0].trim();
    } catch { /* unreadable rule — list it with no glob */ }
    out.push({ file, glob, absolutePath });
  }
  return out;
}

export async function listContext(projectPath: string): Promise<ContextGroup[]> {
  const slug = cwdToProjectSlug(projectPath);
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

  return discoverContext({
    projectRoot: projectPath, homeDir: HOME, projectSlug: slug,
    projectInstructionFiles: Object.keys(projInstr), projectInstructionPaths: projInstr,
    projectRules: projRules,
    globalInstructionFiles: Object.keys(globalInstr), globalInstructionPaths: globalInstr,
    globalRules,
    memoryFiles, memoryPaths,
  });
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
