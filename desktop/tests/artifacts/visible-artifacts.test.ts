import { describe, it, expect } from 'vitest';
import { trackedArtifacts } from '../../src/main/artifacts/visible-artifacts';

describe('trackedArtifacts', () => {
  it('always includes internal artifacts', () => {
    const arts = [
      { kind: 'internal', absolutePath: null, id: 'a' },
      { kind: 'internal', absolutePath: null, id: 'b' },
    ];
    expect(trackedArtifacts(arts, []).map((a: any) => a.id)).toEqual(['a', 'b']);
  });

  it('includes external artifacts only when manually included', () => {
    const arts = [
      { kind: 'external', absolutePath: 'c:/temp/in.xlsx', id: 'in' },
      { kind: 'external', absolutePath: 'c:/temp/out.xlsx', id: 'out' },
    ];
    const includes = [{ path: 'c:/temp/in.xlsx' }];
    expect(trackedArtifacts(arts, includes).map((a: any) => a.id)).toEqual(['in']);
  });

  it('matches included externals across Windows drive-case + separator differences', () => {
    // The real-world bug: the tracker stores the RAW path (uppercase drive,
    // sometimes backslashes) while manualIncludes stores the CANONICAL form
    // (lowercase drive, forward slashes). Both must match.
    const arts = [
      { kind: 'external', absolutePath: 'C:/Temp/Report.xlsx', id: 'fwd' },
      { kind: 'external', absolutePath: 'C:\\Temp\\Other.xlsx', id: 'back' },
    ];
    const includes = [
      { path: 'c:/Temp/Report.xlsx' },
      { path: 'c:/Temp/Other.xlsx' },
    ];
    expect(trackedArtifacts(arts, includes).map((a: any) => a.id)).toEqual(['fwd', 'back']);
  });

  it('excludes externals with no absolutePath', () => {
    const arts = [{ kind: 'external', absolutePath: null, id: 'x' }];
    expect(trackedArtifacts(arts, [{ path: 'c:/x' }])).toEqual([]);
  });
});
