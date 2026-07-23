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

  // Rule 4 flipped (2026-07-23 file-merge spec): externals are visible on their
  // own edit history, mirroring rule 3 for internals. Pins are no longer the
  // gate — nothing writes manualIncludes once "+ Add file" becomes an import.
  it('shows external artifacts with Claude work, without any pin', () => {
    const arts = [
      { kind: 'external', path: 'made.xlsx', absolutePath: 'c:/temp/made.xlsx', versions: [edit], id: 'made' },
      { kind: 'external', path: 'new.md', absolutePath: 'c:/temp/new.md', versions: [{ type: 'create' }], id: 'new' },
    ];
    expect(trackedArtifacts(arts, [], [], ROOT).map((a: any) => a.id)).toEqual(['made', 'new']);
  });

  it('hides external files that were only VIEWED (read-only versions)', () => {
    // Same bar as rule 3 — a pill click must not populate External Artifacts.
    const arts = [
      { kind: 'external', path: 'seen.pdf', absolutePath: 'c:/temp/seen.pdf', versions: [read], id: 'seen' },
      { kind: 'external', path: 'made.pdf', absolutePath: 'c:/temp/made.pdf', versions: [edit], id: 'made' },
    ];
    expect(trackedArtifacts(arts, [], [], ROOT).map((a: any) => a.id)).toEqual(['made']);
  });

  it('still shows a legacy pinned external with only read versions (rule 1 survives)', () => {
    // Upgrade safety: existing users pinned externals with the old "+ Add file".
    // Rule 1 keeps those visible even though they would fail the new rule 4.
    const arts = [
      { kind: 'external', path: 'pinned.pdf', absolutePath: 'c:/temp/pinned.pdf', versions: [read], id: 'pinned' },
    ];
    const includes = [{ path: 'c:/temp/pinned.pdf' }];
    expect(trackedArtifacts(arts, includes, [], ROOT).map((a: any) => a.id)).toEqual(['pinned']);
  });

  it('still hides an excluded external with Claude work (rule 2 survives)', () => {
    const arts = [
      { kind: 'external', path: 'noisy.md', absolutePath: 'c:/temp/noisy.md', versions: [edit], id: 'noisy' },
      { kind: 'external', path: 'keep.md', absolutePath: 'c:/temp/keep.md', versions: [edit], id: 'keep' },
    ];
    const excludes = ['c:/temp/noisy.md'];
    expect(trackedArtifacts(arts, [], excludes, ROOT).map((a: any) => a.id)).toEqual(['keep']);
  });
});
