import { describe, it, expect } from 'vitest';
import {
  parseNvidiaSmiMemory,
  parseRegistryQwMemorySize,
  parseSystemProfilerVram,
} from '../src/main/models/gpu-detector';

const GB = 1024 ** 3;
const MIB = 1024 * 1024;

describe('parseNvidiaSmiMemory', () => {
  it('takes the largest GPU across multi-line MiB output, in bytes', () => {
    // `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`
    // on a dual-GPU box: a 24GB RTX 4090 (24564 MiB) + an 8GB card.
    expect(parseNvidiaSmiMemory('24564\n8192\n')).toBe(24564 * MIB);
  });
  it('handles a single GPU with a trailing newline', () => {
    expect(parseNvidiaSmiMemory('16376\n')).toBe(16376 * MIB);
  });
  it('empty output → null', () => {
    expect(parseNvidiaSmiMemory('')).toBeNull();
  });
  it('non-numeric garbage → null', () => {
    expect(parseNvidiaSmiMemory('garbage')).toBeNull();
    expect(parseNvidiaSmiMemory('N/A\n\n')).toBeNull();
  });
});

describe('parseRegistryQwMemorySize', () => {
  it('takes the max plausible QWORD (bytes) across adapters', () => {
    // ExpandProperty prints one integer per adapter: a 24GB discrete card
    // (25757220864) alongside a small Intel iGPU carve-out (1073741824 = 1GB).
    // The parser returns the max; the iGPU floor is applied by the dispatcher.
    expect(parseRegistryQwMemorySize('25757220864\n1073741824\n')).toBe(25757220864);
  });
  it('single adapter with blank lines around it', () => {
    expect(parseRegistryQwMemorySize('\n8589934592\n\n')).toBe(8 * GB);
  });
  it('ignores implausibly huge / zero / negative junk', () => {
    // A sign-extended-garbage value beyond 1TB is rejected; the real 8GB wins.
    expect(parseRegistryQwMemorySize('999999999999999999\n0\n8589934592\n')).toBe(8 * GB);
  });
  it('empty output → null', () => {
    expect(parseRegistryQwMemorySize('')).toBeNull();
  });
  it('non-numeric garbage → null', () => {
    expect(parseRegistryQwMemorySize('no such property\n')).toBeNull();
  });
});

describe('parseSystemProfilerVram', () => {
  it('parses "VRAM (Total): N GB" to bytes', () => {
    const out = [
      'Graphics/Displays:',
      '    AMD Radeon Pro 5500M:',
      '      Chipset Model: AMD Radeon Pro 5500M',
      '      VRAM (Total): 8 GB',
    ].join('\n');
    expect(parseSystemProfilerVram(out)).toBe(8 * GB);
  });
  it('parses a "VRAM (Dynamic, Max): N MB" figure', () => {
    expect(parseSystemProfilerVram('      VRAM (Dynamic, Max): 1536 MB')).toBe(1536 * MIB);
  });
  it('no VRAM line → null', () => {
    expect(parseSystemProfilerVram('Graphics/Displays:\n    Intel Iris:\n')).toBeNull();
  });
});
