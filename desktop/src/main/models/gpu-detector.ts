// Best-effort DEDICATED-GPU VRAM probe (spec §4.3 + Amendment 2026-07-14 F).
// IMPURE + platform-specific. Feeds fit-estimator's optional VRAM input.
//
// CONTRACT / SAFETY BIAS: return a non-null `totalVramBytes` ONLY when a real
// DEDICATED GPU's VRAM was confidently probed. EVERY failure/uncertainty —
// no GPU, an integrated GPU (its "memory" is shared system RAM, so counting it
// would double-count), a probe that throws, an implausible reading — returns
// { name: null, totalVramBytes: null } so the estimator falls back to RAM-only.
// Because a null can never worsen a verdict (see fit-estimator), being wrong in
// the null direction is always safe; being wrong in the non-null direction
// over-promises. So we bias hard toward null.
//
// Every probe is wrapped in try/catch and NEVER throws. Result is cached at
// module level (VRAM is fixed for the process lifetime) so repeat calls — one
// per fit computation in the panel — don't re-shell.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import type { GpuInfo } from '../../shared/model-manager-types';

const GB = 1024 ** 3;
// A dedicated GPU floor. Integrated GPUs (Intel iGPU / AMD APU) sometimes report
// a small carve-out via the Windows registry qwMemorySize (128MB–1GB of shared
// RAM); a real discrete card is ≥2GB. Readings below this are treated as
// integrated/implausible → no dedicated VRAM. Conservative on purpose: a
// false-null just means RAM-only, which is the safe direction.
const MIN_DEDICATED_VRAM_BYTES = 2 * GB;
// Reject absurd readings (driver junk / sign-extended garbage) as implausible.
const MAX_PLAUSIBLE_VRAM_BYTES = 1024 * GB;

const NULL_GPU: GpuInfo = { name: null, totalVramBytes: null };

// ---------- pure parse helpers (unit-tested) ----------

export function parseNvidiaSmiMemory(stdout: string): number | null {
  // `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` → MiB
  // lines, one per GPU. Take the largest. Returns BYTES, or null if unparseable.
  const mibs = stdout.split('\n').map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return mibs.length ? Math.max(...mibs) * 1024 * 1024 : null;
}

// Parses the output of THIS exact PowerShell command (kept in sync with
// `readRegistryVram` below):
//   Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*'
//     -Name 'HardwareInformation.qwMemorySize' -EA SilentlyContinue |
//     Select-Object -ExpandProperty 'HardwareInformation.qwMemorySize'
// which prints one integer (VRAM in BYTES) per display adapter that carries the
// value — e.g. a 24GB card prints `25757220864`. Adapters without the property
// (many virtual/basic-display drivers) print nothing. Returns the MAX plausible
// value in BYTES, or null if empty/unparseable. WHY qwMemorySize and not
// Win32_VideoController.AdapterRAM: AdapterRAM is a signed 32-bit field that
// caps at 4GB and misreports large cards; qwMemorySize is a reliable 64-bit QWORD.
export function parseRegistryQwMemorySize(stdout: string): number | null {
  const vals = stdout.split('\n').map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_PLAUSIBLE_VRAM_BYTES);
  return vals.length ? Math.max(...vals) : null;
}

// Intel Macs: parse `system_profiler SPDisplaysDataType` for a line like
// `VRAM (Total): 4 GB` or `VRAM (Dynamic, Max): 1536 MB`. Returns BYTES or null.
export function parseSystemProfilerVram(stdout: string): number | null {
  const re = /VRAM\s*\([^)]*\)\s*:\s*([\d.]+)\s*(MB|GB)/gi;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const bytes = m[2].toUpperCase() === 'GB' ? n * GB : n * 1024 * 1024;
    if (best === null || bytes > best) best = bytes;
  }
  return best;
}

// ---------- impure probes (best-effort, never throw) ----------

function runCmd(file: string, args: string[]): string | null {
  try {
    // Short timeout so a hung/absent tool can't stall the panel; windowsHide
    // keeps a console flash from appearing.
    return execFileSync(file, args, {
      timeout: 4000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // tool missing, non-zero exit, or timeout — all non-fatal.
  }
}

function readNvidiaSmiVram(): number | null {
  const out = runCmd('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
  return out ? parseNvidiaSmiMemory(out) : null;
}

function readNvidiaSmiName(): string | null {
  const out = runCmd('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
  if (!out) return null;
  const first = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return first ?? null;
}

function readRegistryVram(): number | null {
  const cmd =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' " +
    "-Name 'HardwareInformation.qwMemorySize' -EA SilentlyContinue | " +
    "Select-Object -ExpandProperty 'HardwareInformation.qwMemorySize'";
  const out = runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  return out ? parseRegistryQwMemorySize(out) : null;
}

function detectWindows(): GpuInfo {
  // nvidia-smi is authoritative (only ever present for a real NVIDIA discrete
  // card). The registry QWORD can include an iGPU carve-out, so gate it on the
  // dedicated floor; then take the larger of the two confident readings.
  const smi = readNvidiaSmiVram();
  const reg = readRegistryVram();
  const regDedicated = reg != null && reg >= MIN_DEDICATED_VRAM_BYTES ? reg : null;
  const candidates = [smi, regDedicated].filter((n): n is number => n != null && n >= MIN_DEDICATED_VRAM_BYTES);
  if (!candidates.length) return NULL_GPU;
  const totalVramBytes = Math.max(...candidates);
  // Name is diagnostics-only; only trust it when nvidia-smi produced the figure.
  const name = smi != null ? readNvidiaSmiName() : null;
  return { name, totalVramBytes };
}

function detectMac(): GpuInfo {
  // Apple Silicon = unified memory: the GPU shares system RAM, so its usable
  // working set is a fraction of total RAM (Metal caps the GPU allocation).
  // 0.7 mirrors the estimator's RAM headroom — the model still runs on the
  // "GPU" here, which is why we DO surface a VRAM figure on Apple Silicon.
  if (process.arch === 'arm64') {
    return { name: 'Apple Silicon (unified memory)', totalVramBytes: Math.floor(os.totalmem() * 0.7) };
  }
  // Intel Mac: a discrete/embedded GPU reports VRAM via system_profiler.
  const out = runCmd('system_profiler', ['SPDisplaysDataType']);
  const vram = out ? parseSystemProfilerVram(out) : null;
  if (vram == null || vram < MIN_DEDICATED_VRAM_BYTES) return NULL_GPU;
  return { name: null, totalVramBytes: vram };
}

function readAmdSysfsVram(): number | null {
  // AMD discrete cards expose total VRAM in BYTES at
  // /sys/class/drm/card*/device/mem_info_vram_total. Take the max across cards.
  try {
    const base = '/sys/class/drm';
    const cards = fs.readdirSync(base).filter((d) => /^card\d+$/.test(d));
    let best: number | null = null;
    for (const card of cards) {
      try {
        const raw = fs.readFileSync(`${base}/${card}/device/mem_info_vram_total`, 'utf8').trim();
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
      } catch {
        /* card without the file (iGPU / non-AMD) — skip. */
      }
    }
    return best;
  } catch {
    return null;
  }
}

function detectLinux(): GpuInfo {
  // NVIDIA first (authoritative + carries a name), then AMD sysfs.
  const smi = readNvidiaSmiVram();
  if (smi != null && smi >= MIN_DEDICATED_VRAM_BYTES) {
    return { name: readNvidiaSmiName(), totalVramBytes: smi };
  }
  const amd = readAmdSysfsVram();
  if (amd != null && amd >= MIN_DEDICATED_VRAM_BYTES) {
    return { name: null, totalVramBytes: amd };
  }
  return NULL_GPU;
}

let cached: GpuInfo | undefined;

/** Best-effort dedicated-VRAM probe. Cached; never throws. Non-null VRAM only
 *  on a confidently-detected dedicated GPU (incl. Apple Silicon unified mem). */
export async function detectGpu(): Promise<GpuInfo> {
  if (cached !== undefined) return cached;
  try {
    switch (process.platform) {
      case 'win32': cached = detectWindows(); break;
      case 'darwin': cached = detectMac(); break;
      case 'linux': cached = detectLinux(); break;
      default: cached = NULL_GPU;
    }
  } catch {
    // Belt-and-suspenders: the platform helpers already swallow their own
    // errors, but a top-level throw must still degrade to RAM-only.
    cached = NULL_GPU;
  }
  return cached;
}
