// TWO identities live here. They are NOT the same thing and must not be merged.
//
// 1. getDeviceIdentity(userData) — per-INSTALL, for LEASE coordination.
//    userData-scoped ON PURPOSE: the dev instance and built app share ~/.claude but
//    have separate userData, so they get distinct ids and leases coordinate them
//    cross-process (spec §3.4). Do not "fix" this to be machine-scoped.
//
// 2. getMachineIdentity(builtAppUserData) — per-MACHINE, for the DEVICE REGISTRY.
//    "Your devices" means physical machines, so every profile on one machine must
//    resolve to ONE id. The built app's userData id IS the machine identity; dev
//    profiles READ it and never mint their own. Before this split, the registry
//    reused the per-install id and every YOUCODED_PROFILE added a permanent
//    duplicate row (three "GalaxyBook" rows, 2026-07-16).
//
// Why not ~/.claude/youcoded-device-id.json: that dir is the one most likely to be
// replicated across machines (dotfile repos; the app's own "memory + skills sync"
// roadmap). A shared machine id would silently merge two real machines into one
// row. %APPDATA% is never dotfile-synced.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Reads a device-id.json without ever creating one. Returns null for
// absent/corrupt/empty — callers treat null as "no durable identity here".
function readIdFile(dir: string): { id: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'device-id.json'), 'utf8'));
    if (typeof parsed?.id === 'string' && parsed.id) return { id: parsed.id };
  } catch { /* absent or corrupt */ }
  return null;
}

export function getDeviceIdentity(userDataDir: string): { id: string } {
  const existing = readIdFile(userDataDir);
  // Reuse the existing id so this install keeps ONE stable identity across launches.
  if (existing) return existing;
  const fresh = { id: randomUUID() };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'device-id.json'), JSON.stringify(fresh));
  } catch { /* read-only disk: ephemeral id this launch — see getMachineIdentity */ }
  return fresh;
}

/** The per-MACHINE identity for the device registry: the BUILT app's install id.
 *
 *  Pass the BUILT app's userData dir — main.ts captures it from
 *  app.getPath('userData') BEFORE applying any dev-profile override. Taking it as
 *  a parameter (rather than deriving `<appData>/youcoded` here) keeps the app's
 *  folder name out of this file: Electron derives it from the app name, and
 *  hardcoding the current value would silently resolve to null on every platform
 *  if a productName were ever added to package.json.
 *
 *  READ-ONLY on purpose — a dev profile must never mint the built app's identity,
 *  or whichever instance launched first would win and orphan the real row.
 *
 *  null means "no durable machine identity" and the caller MUST skip registration.
 *  Two cases both land here, and both should register nothing rather than a ghost:
 *    - the built app has never run on this machine (a dev-only checkout), and
 *    - getDeviceIdentity's write failed, leaving an ephemeral in-memory id. That
 *      second case is why durability is structural here: registering an ephemeral
 *      id would leave a NEW orphan row on EVERY launch. */
export function getMachineIdentity(builtAppUserDataDir: string): { id: string } | null {
  return readIdFile(builtAppUserDataDir);
}
