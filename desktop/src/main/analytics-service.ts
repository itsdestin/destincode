// Sends one /app/heartbeat per UTC day, gated by an opt-out toggle.
// Identity is HMAC_SHA256(SALT, machine_id || platform), computed
// client-side. Fire-and-forget — any failure is swallowed and retried
// next launch. Zero behavioral impact if the network is unreachable.
//
// Privacy: the raw machine_id never leaves the device. See the design
// spec at docs/superpowers/specs/2026-05-01-device-id-analytics-design.md
// for the threat model.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID, createHmac } from "node:crypto";
import { machineIdSync } from "node-machine-id";
import { ANALYTICS_SALT } from "./analytics-salt";

// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
const API_BASE = "https://api.youcoded.ai";
const ANALYTICS_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");

interface AnalyticsState {
  optIn: boolean;
  lastPingedDate: string;       // YYYY-MM-DD UTC, or "" when never pinged
  fallbackDeviceId?: string;    // present only if machine_id read failed
}

function defaultState(): AnalyticsState {
  return { optIn: true, lastPingedDate: "" };
}

function mapOs(platform: NodeJS.Platform): string {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  return "";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function readState(): AnalyticsState {
  try {
    const raw = fs.readFileSync(ANALYTICS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AnalyticsState> & {
      installId?: string;
      installReported?: boolean;
    };
    // Drop legacy installId / installReported silently — they're meaningless
    // post-cutover. The on-disk file gets rewritten on the next writeState().
    return {
      optIn: typeof parsed.optIn === "boolean" ? parsed.optIn : true,
      lastPingedDate: typeof parsed.lastPingedDate === "string" ? parsed.lastPingedDate : "",
      fallbackDeviceId: typeof parsed.fallbackDeviceId === "string" ? parsed.fallbackDeviceId : undefined,
    };
  } catch {
    return defaultState();
  }
}

function writeState(state: AnalyticsState): void {
  fs.mkdirSync(path.dirname(ANALYTICS_FILE), { recursive: true });
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(state, null, 2));
}

export function getOptIn(): boolean {
  return readState().optIn;
}

export function setOptIn(value: boolean): void {
  const state = readState();
  state.optIn = value;
  writeState(state);
}

// Computes the device-id hash. Mutates state.fallbackDeviceId and persists
// the state file when the machine_id read fails.
export function deviceIdHash(state: AnalyticsState): string {
  let raw = "";
  try {
    raw = machineIdSync(true);  // `true` = return raw machine_id rather than the SHA-256 of it
  } catch {
    // swallowed — caught by the length check below
  }
  if (!raw || raw.length < 8) {
    if (!state.fallbackDeviceId) {
      state.fallbackDeviceId = randomUUID();
      writeState(state);
    }
    raw = `fallback:${state.fallbackDeviceId}`;
  }
  return createHmac("sha256", ANALYTICS_SALT)
    .update(`${raw}|${process.platform}`)
    .digest("hex");
}

async function postEvent(p: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runAnalyticsOnLaunch(): Promise<void> {
  const state = readState();
  if (!state.optIn) return;

  const today = todayUtc();
  if (state.lastPingedDate === today) return;

  const hash = deviceIdHash(state);

  const ok = await postEvent("/app/heartbeat", {
    deviceIdHash: hash,
    appVersion: app.getVersion(),
    platform: "desktop" as const,
    os: mapOs(process.platform),
  });
  if (ok) {
    state.lastPingedDate = today;
    writeState(state);
  }
}
