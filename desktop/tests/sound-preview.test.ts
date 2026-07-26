import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { STOCK_PRESETS } from '../src/renderer/utils/sounds';

// Guard for the audition bug: hearing a preset must not assign it.
//
// PresetSelector fired onSelect(id) and playPreview(id) from ONE handler, so
// shopping through 15 presets meant overwriting the setting 15 times. Auditioning
// and assigning are different intents and need different affordances.

const PANEL = join(__dirname, '..', 'src', 'renderer', 'components', 'SettingsPanel.tsx');

describe('sound presets', () => {
  it('preview and select are not fired from the same handler', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(
      src,
      'Auditioning a sound must not assign it -- give preview its own control.',
    ).not.toMatch(/onSelect\([^)]*\);\s*playPreview\(/);
  });

  it('every stock preset carries a description', () => {
    expect(STOCK_PRESETS.length).toBeGreaterThan(10);
    for (const preset of STOCK_PRESETS) {
      expect(preset.desc, `${preset.id} needs a desc`).toBeTruthy();
    }
  });
});
