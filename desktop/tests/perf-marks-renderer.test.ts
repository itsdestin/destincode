import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
const R = join(__dirname, '..', 'src', 'renderer');
const index = readFileSync(join(R, 'index.tsx'), 'utf8');
const app = readFileSync(join(R, 'App.tsx'), 'utf8');
describe('renderer perf marks (read by youcoded-dev/scripts/perf-lab)', () => {
  it('index.tsx marks start and root render, in that order', () => {
    const a = index.indexOf(`performance.mark('yc:index-start')`);
    const b = index.indexOf(`performance.mark('yc:root-render')`);
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
  });
  it('App.tsx marks mount and sessions-listed', () => {
    expect(app).toContain(`performance.mark('yc:app-mounted')`);
    expect(app).toContain(`performance.mark('yc:sessions-listed')`);
  });
});
