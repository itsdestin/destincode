// Per-INSTALL identity for lease coordination. userData-scoped ON PURPOSE:
// the dev instance and built app share ~/.claude but have separate userData,
// so they get distinct ids and leases coordinate them cross-process (spec §3.4).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function getDeviceIdentity(userDataDir: string): { id: string } {
  const p = path.join(userDataDir, 'device-id.json');
  try {
    // Reuse the existing id so this install keeps ONE stable identity across launches.
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof parsed?.id === 'string' && parsed.id) return { id: parsed.id };
  } catch { /* absent or corrupt — regenerate below */ }
  const fresh = { id: randomUUID() };
  try { fs.writeFileSync(p, JSON.stringify(fresh)); } catch { /* read-only disk: ephemeral id this launch */ }
  return fresh;
}
