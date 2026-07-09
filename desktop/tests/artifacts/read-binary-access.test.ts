import { describe, it, expect } from 'vitest';
import {
  isSensitivePath,
  isUnderRoot,
  evaluateBinaryRead,
} from '../../src/main/artifacts/read-binary-access';

describe('isSensitivePath', () => {
  it('refuses well-known secret directories anywhere in the path', () => {
    expect(isSensitivePath('c:/users/desti/.ssh/id_rsa')).toBe(true);
    expect(isSensitivePath('c:/users/desti/.gnupg/private-keys-v1.d/key')).toBe(true);
    expect(isSensitivePath('c:/users/desti/.aws/credentials')).toBe(true);
    expect(isSensitivePath('/home/u/.kube/config')).toBe(true);
  });

  it('refuses credential-store basenames', () => {
    expect(isSensitivePath('c:/users/desti/.netrc')).toBe(true);
    expect(isSensitivePath('c:/users/desti/_netrc')).toBe(true);
    expect(isSensitivePath('c:/users/desti/.claude/.credentials.json')).toBe(true);
  });

  it('refuses the gh config dir (holds the OAuth token)', () => {
    expect(isSensitivePath('c:/users/desti/.config/gh/hosts.yml')).toBe(true);
  });

  it('allows ordinary project files', () => {
    expect(isSensitivePath('c:/users/desti/project/report.xlsx')).toBe(false);
    expect(isSensitivePath('c:/users/desti/project/docs/plan.pdf')).toBe(false);
    // Names that merely CONTAIN a sensitive word aren't refused
    expect(isSensitivePath('c:/users/desti/project/ssh-notes.md')).toBe(false);
    expect(isSensitivePath('c:/users/desti/project/netrc-parser.ts')).toBe(false);
  });
});

describe('isUnderRoot', () => {
  it('matches the root itself and nested paths', () => {
    expect(isUnderRoot('c:/proj', 'c:/proj')).toBe(true);
    expect(isUnderRoot('c:/proj/a/b.xlsx', 'c:/proj')).toBe(true);
  });

  it('does not match sibling dirs sharing a prefix', () => {
    expect(isUnderRoot('c:/proj-evil/x.pdf', 'c:/proj')).toBe(false);
  });
});

describe('evaluateBinaryRead', () => {
  const roots = ['c:/users/desti/project', 'c:/users/desti/other'];

  it('allows files under a known root', () => {
    expect(evaluateBinaryRead('c:/users/desti/project/a.xlsx', roots, new Set())).toBe('allowed');
  });

  it('allows tracked external artifacts outside every root (temp files)', () => {
    const tracked = new Set(['c:/users/desti/appdata/local/temp/report.xlsx']);
    expect(evaluateBinaryRead('c:/users/desti/appdata/local/temp/report.xlsx', roots, tracked)).toBe('allowed');
  });

  it('refuses paths outside roots and not tracked', () => {
    expect(evaluateBinaryRead('c:/windows/system32/config/sam', roots, new Set())).toBe('outside-roots');
  });

  it('refuses sensitive paths even inside an allowed root', () => {
    // The seeded "Home" saved folder makes most of the home dir a root — the
    // sensitive check must still win.
    const homeRoot = ['c:/users/desti'];
    expect(evaluateBinaryRead('c:/users/desti/.ssh/id_rsa', homeRoot, new Set())).toBe('sensitive');
    expect(evaluateBinaryRead('c:/users/desti/.claude/.credentials.json', homeRoot, new Set())).toBe('sensitive');
  });

  it('sensitive wins over tracked (a tracked record cannot whitelist a secret)', () => {
    const tracked = new Set(['c:/users/desti/.ssh/id_rsa']);
    expect(evaluateBinaryRead('c:/users/desti/.ssh/id_rsa', ['c:/users/desti'], tracked)).toBe('sensitive');
  });
});
