import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css'),
  'utf8',
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS selector: ${selector}`).toBeTruthy();
  return match![1].replace(/\\s+/g, ' ').trim();
}

describe('wide toggle motion policy', () => {
  it('snaps indicator geometry while environmental measurements synchronize', () => {
    expect(ruleBody(".wide-view-toggle[data-geometry-syncing='true'] .wide-view-toggle-indicator"))
      .toContain('transition-duration: 0ms');
  });

  it('disables spatial toggle transitions for the app Reduced Effects setting', () => {
    expect(ruleBody('[data-reduced-effects] .wide-view-toggle-indicator'))
      .toContain('transition-duration: 0ms');
    expect(ruleBody('[data-reduced-effects] .wide-view-toggle-label'))
      .toContain('transition-duration: 0ms');
  });

  it('duplicates the same declarations for the OS reduced-motion preference', () => {
    const media = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)?.join('\n') ?? '';
    expect(media).toContain('.wide-view-toggle-indicator');
    expect(media).toContain('.wide-view-toggle-label');
    expect(media.match(/transition-duration:\s*0ms/g)).toHaveLength(2);
  });
});
