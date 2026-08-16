// project-view-default-selection.test.ts
//
// Project view homes to the FOCUSED conversation's folder every time it opens,
// rather than restoring whatever project was browsed last (the component never
// unmounts, so the old code's `prev` branch made the selection sticky for the
// life of the app run). `matchProjectByPath` is the lookup that decision rests
// on; the open-time effect in ProjectView falls back to projects[0] when it
// returns null.
//
// The spellings matter: a project's `path` comes off the central index, the cwd
// comes off the live session, and on Windows those two can disagree on
// separators and case for the SAME folder. A miss here is invisible — the view
// just silently opens on the wrong project.
import { describe, it, expect } from 'vitest';
import { matchProjectByPath } from '../src/renderer/components/project-view/ProjectView';

const P = (path: string) => ({ path });

describe('matchProjectByPath', () => {
  it('finds the project whose folder is the cwd', () => {
    const projects = [P('/home/d/alpha'), P('/home/d/beta')];
    expect(matchProjectByPath(projects, '/home/d/beta')).toBe(projects[1]);
  });

  it('matches a Windows cwd against a forward-slash indexed path', () => {
    const projects = [P('C:/Users/d/proj')];
    expect(matchProjectByPath(projects, 'C:\\Users\\d\\proj')).toBe(projects[0]);
  });

  it('matches a lowercased indexed path (canonicalized Windows entries)', () => {
    const projects = [P('c:/users/d/proj')];
    expect(matchProjectByPath(projects, 'C:\\Users\\d\\proj')).toBe(projects[0]);
  });

  // Both of these hand the caller its projects[0] fallback rather than a wrong
  // project — a conversation can live in a folder that was never saved as a
  // project, and the welcome screen has no focused conversation at all.
  it('returns null when the cwd is not an indexed project', () => {
    expect(matchProjectByPath([P('/home/d/alpha')], '/home/d/somewhere-else')).toBeNull();
  });

  it('returns null when there is no focused conversation', () => {
    expect(matchProjectByPath([P('/home/d/alpha')], undefined)).toBeNull();
  });

  it('returns null against an empty index', () => {
    expect(matchProjectByPath([], '/home/d/alpha')).toBeNull();
  });
});
