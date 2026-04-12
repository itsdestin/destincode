import fs from 'fs';
import path from 'path';
import os from 'os';
import { PluginManifest, ProvidedCapability, OptionalIntegration } from '../shared/types';

/**
 * Integration Reconciler (decomposition v3, §4)
 *
 * Scans ~/.claude/plugins/ * /plugin.json for `provides` and `optionalIntegrations`,
 * merges them into a capability map, and writes ~/.claude/integration-context.md
 * which session-start.sh injects into the session preamble so Claude can route
 * cross-skill references correctly.
 *
 * Triggered on app launch and after any plugin install / uninstall.
 *
 * Format was locked by the prompt-engineering spike (see spike-test-scenarios.md)
 * — 5/5 routing accuracy with a frontmatter sentence + Capability/Status/Instruction
 * table + closing rule sentence.
 */

const PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');
const OUTPUT_PATH = path.join(os.homedir(), '.claude', 'integration-context.md');

interface ProviderEntry {
  packageName: string;
  capability: ProvidedCapability;
}

interface ReconciledRow {
  capability: string;
  status: 'installed' | 'not-installed';
  provider?: string; // package name, only when installed
  instruction: string;
}

/**
 * Read a plugin.json from either `<plugin>/plugin.json` or
 * `<plugin>/.claude-plugin/plugin.json` — Claude Code supports both layouts.
 */
function readPluginManifest(pluginDir: string): PluginManifest | null {
  const candidates = [
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    path.join(pluginDir, 'plugin.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw) as PluginManifest;
    } catch {
      // Malformed JSON — skip this manifest, don't fail the whole reconciliation
      continue;
    }
  }
  return null;
}

function listInstalledManifests(): PluginManifest[] {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const manifests: PluginManifest[] = [];
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readPluginManifest(path.join(PLUGINS_DIR, entry.name));
    if (manifest && manifest.name) manifests.push(manifest);
  }
  return manifests;
}

/**
 * Build capability map: for each `provides` entry across all installed plugins,
 * record who provides it. First-write-wins if two packages provide the same
 * capability (shouldn't happen in practice; worth revisiting if users start
 * installing conflicting community packages).
 */
function buildProviderMap(manifests: PluginManifest[]): Map<string, ProviderEntry> {
  const map = new Map<string, ProviderEntry>();
  for (const m of manifests) {
    if (!m.provides) continue;
    for (const [capability, desc] of Object.entries(m.provides)) {
      if (!map.has(capability)) {
        map.set(capability, { packageName: m.name, capability: desc });
      }
    }
  }
  return map;
}

/**
 * For each `optionalIntegrations` entry declared by any installed plugin,
 * produce a row describing whether the capability is currently fulfilled and
 * what instruction Claude should follow.
 */
function buildRows(
  manifests: PluginManifest[],
  providerMap: Map<string, ProviderEntry>,
): ReconciledRow[] {
  const seen = new Set<string>();
  const rows: ReconciledRow[] = [];
  for (const m of manifests) {
    if (!m.optionalIntegrations) continue;
    for (const [capability, integration] of Object.entries(m.optionalIntegrations)) {
      if (seen.has(capability)) continue; // dedup across packages that declare the same integration
      seen.add(capability);
      const provider = providerMap.get(capability);
      if (provider) {
        rows.push({
          capability,
          status: 'installed',
          provider: provider.packageName,
          instruction: integration.whenAvailable,
        });
      } else {
        rows.push({
          capability,
          status: 'not-installed',
          instruction: integration.whenUnavailable,
        });
      }
    }
  }
  return rows;
}

/**
 * Render the routing table as markdown. Format locked by the prompt spike —
 * changes here should be re-validated against spike-test-scenarios.md before
 * shipping.
 */
function renderContext(rows: ReconciledRow[]): string {
  if (rows.length === 0) {
    // No integrations declared — emit an empty marker so session-start.sh
    // can still inject a deterministic block without special-casing absence.
    return '## Skill Integration Status\n\nNo cross-skill integrations are currently declared.\n';
  }

  const lines: string[] = [];
  lines.push('## Skill Integration Status');
  lines.push('');
  lines.push('The following cross-skill integrations are active based on installed packages. When a skill or workflow would normally invoke one of these capabilities, follow the instruction in the rightmost column.');
  lines.push('');
  lines.push('| Capability | Status | Instruction |');
  lines.push('|------------|--------|-------------|');
  for (const r of rows) {
    const status = r.status === 'installed'
      ? `Installed (${r.provider})`
      : 'Not installed';
    // Escape pipes in instruction text so the markdown table stays intact
    const instruction = r.instruction.replace(/\|/g, '\\|');
    lines.push(`| \`${r.capability}\` | ${status} | ${instruction} |`);
  }
  lines.push('');
  lines.push('When a skill references one of these capabilities in its instructions, follow the instruction in the rightmost column instead of the skill\'s original reference. If a capability is not listed here, handle the request generically.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Write atomically via tmp + rename so session-start.sh never reads a
 * partially-written file.
 */
function writeAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

export interface ReconcileResult {
  rowCount: number;
  providerCount: number;
  outputPath: string;
}

/**
 * Run the full reconciliation cycle: scan plugins, merge manifests, write
 * integration-context.md. Safe to call repeatedly; returns a summary for
 * logging / diagnostics.
 */
export function reconcileIntegrations(): ReconcileResult {
  const manifests = listInstalledManifests();
  const providerMap = buildProviderMap(manifests);
  const rows = buildRows(manifests, providerMap);
  const content = renderContext(rows);
  writeAtomic(OUTPUT_PATH, content);
  return {
    rowCount: rows.length,
    providerCount: providerMap.size,
    outputPath: OUTPUT_PATH,
  };
}

// Exposed for tests
export const __test = {
  buildProviderMap,
  buildRows,
  renderContext,
};
