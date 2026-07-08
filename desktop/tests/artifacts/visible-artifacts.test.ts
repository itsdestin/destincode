import { describe, it, expect } from 'vitest';
import { trackedArtifacts } from '../../src/main/artifacts/visible-artifacts';

const ROOT = 'C:\\proj';
const edit = { type: 'edit' };
const read = { type: 'read' };

describe('trackedArtifacts', () => {
  it('shows internal artifacts with Claude work (non-read versions)', () => {
    const arts = [
      { kind: 'internal', path: 'a.md', absolutePath: null, versions: [{ type: 'create' }], id: 'a' },
      { kind: 'internal', path: 'b.md', absolutePath: null, versions: [edit, read], id: 'b' },
    ];
    expect(trackedArtifacts(arts, [], [], ROOT).map((a: any) => a.id)).toEqual(['a', 'b']);
  });

  it('hides internal files that were only VIEWED (read-only versions)', () => {
    // A pill click on a file Claude merely mentioned tracks a 'read' version —
    // that is not "Claude's work" and must not pollute the Artifacts tab.
    const arts = [
      { kind: 'internal', path: 'seen.md', absolutePath: null, versions: [read], id: 'seen' },
      { kind: 'internal', path: 'made.md', absolutePath: null, versions: [edit], id: 'made' },
    ];
    expect(trackedArtifacts(arts, [], [], ROOT).map((a: any) => a.id)).toEqual(['made']);
  });

  it('shows viewed-only internal files when pinned via manualIncludes', () => {
    const arts = [
      { kind: 'internal', path: 'seen.md', absolutePath: null, versions: [read], id: 'seen' },
    ];
    const includes = [{ path: 'c:/proj/seen.md' }];
    expect(trackedArtifacts(arts, includes, [], ROOT).map((a: any) => a.id)).toEqual(['seen']);
  });

  it('shows external artifacts only when manually included', () => {
    const arts = [
      { kind: 'external', path: 'in.xlsx', absolutePath: 'c:/temp/in.xlsx', versions: [edit], id: 'in' },
      { kind: 'external', path: 'out.xlsx', absolutePath: 'c:/temp/out.xlsx', versions: [edit], id: 'out' },
    ];
    const includes = [{ path: 'c:/temp/in.xlsx' }];
    expect(trackedArtifacts(arts, includes, [], ROOT).map((a: any) => a.id)).toEqual(['in']);
  });

  it('hides excluded internal files even with Claude work (Exclude is sticky)', () => {
    const arts = [
      { kind: 'internal', path: 'noisy.log.md', absolutePath: null, versions: [edit, edit], id: 'noisy' },
      { kind: 'internal', path: 'keep.md', absolutePath: null, versions: [edit], id: 'keep' },
    ];
    const excludes = ['c:/proj/noisy.log.md'];
    expect(trackedArtifacts(arts, [], excludes, ROOT).map((a: any) => a.id)).toEqual(['keep']);
  });

  it('includes WIN over excludes ("+ Add file" is the recovery path)', () => {
    const arts = [
      { kind: 'internal', path: 'both.md', absolutePath: null, versions: [edit], id: 'both' },
    ];
    const includes = [{ path: 'c:/proj/both.md' }];
    const excludes = ['c:/proj/both.md'];
    expect(trackedArtifacts(arts, includes, excludes, ROOT).map((a: any) => a.id)).toEqual(['both']);
  });

  it('matches across Windows drive-case + separator differences', () => {
    // The real-world bug: the tracker stores the RAW path (uppercase drive,
    // sometimes backslashes) while the manual lists store the CANONICAL form.
    const arts = [
      { kind: 'external', path: 'Report.xlsx', absolutePath: 'C:\\Temp\\Report.xlsx', versions: [edit], id: 'fwd' },
    ];
    const includes = [{ path: 'c:/Temp/Report.xlsx' }];
    expect(trackedArtifacts(arts, includes, [], ROOT).map((a: any) => a.id)).toEqual(['fwd']);
  });

  it('excludes externals with no absolutePath', () => {
    const arts = [{ kind: 'external', path: 'x', absolutePath: null, versions: [edit], id: 'x' }];
    expect(trackedArtifacts(arts, [{ path: 'c:/x' }], [], ROOT)).toEqual([]);
  });

  it('treats missing versions arrays as viewed-only (hidden)', () => {
    const arts = [{ kind: 'internal', path: 'a.md', absolutePath: null, id: 'a' } as any];
    expect(trackedArtifacts(arts, [], [], ROOT)).toEqual([]);
  });
});
