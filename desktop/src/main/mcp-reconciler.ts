import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * MCP Reconciler (decomposition v3, §9.3)
 *
 * Scans ~/.claude/plugins/ * /mcp-manifest.json and reconciles Claude Code's
 * ~/.claude.json `mcpServers` section.
 *
 * Scope (deliberately narrow):
 *   - Only auto-registers servers with `auto: true` in the manifest
 *   - Filters by `platform` field so macOS-only servers aren't registered
 *     on Windows (and vice versa)
 *   - Never removes user-added MCP servers
 *   - Expands `{{plugin_root}}` in command/args to the actual plugin dir
 *
 * Servers with `auto: false` (setup required, e.g., iMessages full-disk-access,
 * Todoist OAuth) are skipped — those need the user to act before they work,
 * and surfacing that belongs in the marketplace UI, not a silent reconciler.
 */

const PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

interface McpManifestEntry {
  name: string;
  description?: string;
  platform?: 'macos' | 'windows' | 'linux' | 'all';
  type?: 'stdio' | 'http';
  command?: string;
  command_windows?: string; // platform-specific override
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auto?: boolean;
  setup_note?: string;
}

interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

function currentPlatform(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function platformMatches(declared: McpManifestEntry['platform']): boolean {
  if (!declared || declared === 'all') return true;
  return declared === currentPlatform();
}

function expandTokens(s: string, pluginRoot: string): string {
  return s.replace(/\{\{plugin_root\}\}/g, pluginRoot);
}

function readManifest(pluginDir: string): { entries: McpManifestEntry[]; pluginRoot: string } | null {
  const p = path.join(pluginDir, 'mcp-manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const entries: McpManifestEntry[] = Array.isArray(data) ? data : (data.servers ?? []);
    return { entries, pluginRoot: pluginDir };
  } catch {
    return null;
  }
}

function listManifests(): Array<{ entries: McpManifestEntry[]; pluginRoot: string }> {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const out: Array<{ entries: McpManifestEntry[]; pluginRoot: string }> = [];
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readManifest(path.join(PLUGINS_DIR, entry.name));
    if (m) out.push(m);
  }
  return out;
}

function readClaudeJson(): ClaudeJson {
  try {
    if (!fs.existsSync(CLAUDE_JSON)) return {};
    return JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
  } catch { return {}; }
}

function writeClaudeJsonAtomic(data: ClaudeJson): void {
  const tmp = `${CLAUDE_JSON}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, CLAUDE_JSON);
}

/** Convert a manifest entry to the shape Claude Code expects in .claude.json. */
function buildServerConfig(entry: McpManifestEntry, pluginRoot: string): Record<string, unknown> | null {
  if (entry.type === 'http') {
    if (!entry.url) return null;
    return { type: 'http', url: entry.url };
  }
  // stdio (default)
  const rawCommand = process.platform === 'win32' && entry.command_windows
    ? entry.command_windows
    : entry.command;
  if (!rawCommand) return null;
  const config: Record<string, unknown> = {
    type: 'stdio',
    command: expandTokens(rawCommand, pluginRoot),
  };
  if (entry.args) config.args = entry.args.map(a => expandTokens(a, pluginRoot));
  if (entry.env) config.env = entry.env;
  return config;
}

export interface ReconcileMcpResult {
  added: number;
  skippedPlatform: number;
  skippedManual: number;
  manifestCount: number;
}

export function reconcileMcp(): ReconcileMcpResult {
  const manifests = listManifests();
  const claudeJson = readClaudeJson();
  const servers = (claudeJson.mcpServers as Record<string, unknown>) || {};

  let added = 0;
  let skippedPlatform = 0;
  let skippedManual = 0;
  let changed = false;

  for (const { entries, pluginRoot } of manifests) {
    for (const entry of entries) {
      if (!entry.name) continue;
      if (!platformMatches(entry.platform)) { skippedPlatform++; continue; }
      if (!entry.auto) { skippedManual++; continue; }
      // Never overwrite a user-configured entry — trust their customizations
      if (servers[entry.name]) continue;

      const config = buildServerConfig(entry, pluginRoot);
      if (!config) continue;
      servers[entry.name] = config;
      added++;
      changed = true;
    }
  }

  if (changed) {
    claudeJson.mcpServers = servers;
    writeClaudeJsonAtomic(claudeJson);
  }
  return { added, skippedPlatform, skippedManual, manifestCount: manifests.length };
}
