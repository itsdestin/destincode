import { describe, it, expect } from 'vitest';
import { categorizeArtifact, fileTypeGroup, fileTypeLabel, fileKind, previewKind, fileExtension } from '../../src/shared/artifacts/categorization';

describe('categorizeArtifact', () => {
  it('treats prose, office, and image files as documents', () => {
    const docs = [
      'plan.md', 'README.MD', 'notes.txt', 'scratch.rtf',
      'spec.doc', 'spec.docx', 'budget.xls', 'budget.xlsx',
      'data.csv', 'deck.ppt', 'deck.pptx',
      'invoice.pdf',
      'logo.png', 'photo.JPG', 'avatar.jpeg', 'anim.gif',
      'hero.webp', 'icon.svg', 'old.bmp', 'fav.ico', 'next.avif',
      'mockup.html', 'mockup.HTM',
    ];
    for (const p of docs) {
      expect(categorizeArtifact(p), p).toBe('document');
    }
  });

  it('treats code, configs, and shell as code', () => {
    const code = [
      'index.ts', 'main.tsx', 'app.js', 'app.jsx',
      'service.py', 'main.go', 'lib.rs', 'App.java', 'View.kt',
      'main.cpp', 'main.c', 'header.h', 'Program.cs', 'index.php',
      'styles.css', 'styles.scss',
      'config.json', 'config.yaml', 'config.yml', 'pyproject.toml',
      'settings.ini', '.env', 'data.xml',
      'build.sh', 'deploy.ps1', 'run.bat',
      'app.log',
    ];
    for (const p of code) {
      expect(categorizeArtifact(p), p).toBe('code');
    }
  });

  it('handles paths with directories', () => {
    expect(categorizeArtifact('docs/plans/2026-05-24-x.md')).toBe('document');
    expect(categorizeArtifact('src/main/index.ts')).toBe('code');
    expect(categorizeArtifact('C:\\Users\\me\\file.docx')).toBe('document');
  });

  it('defaults to code on unknown or missing extensions', () => {
    expect(categorizeArtifact('Dockerfile')).toBe('code');
    expect(categorizeArtifact('Makefile')).toBe('code');
    expect(categorizeArtifact('.gitignore')).toBe('code');
    expect(categorizeArtifact('LICENSE')).toBe('code');
    expect(categorizeArtifact('file.unknownextension')).toBe('code');
    expect(categorizeArtifact('')).toBe('code');
  });

  it('is case-insensitive on extension', () => {
    expect(categorizeArtifact('Plan.MD')).toBe('document');
    expect(categorizeArtifact('Photo.JpEg')).toBe('document');
    expect(categorizeArtifact('Index.TS')).toBe('code');
  });
});

describe('fileTypeGroup', () => {
  it('splits documents into image / sheet / document', () => {
    for (const p of ['logo.png', 'photo.JPG', 'icon.svg', 'next.avif', 'a/b/pic.webp']) {
      expect(fileTypeGroup(p), p).toBe('image');
    }
    for (const p of ['budget.xlsx', 'budget.xls', 'data.csv', 'data.TSV']) {
      expect(fileTypeGroup(p), p).toBe('sheet');
    }
    for (const p of ['plan.md', 'notes.txt', 'spec.docx', 'invoice.pdf', 'deck.pptx', 'mockup.html']) {
      expect(fileTypeGroup(p), p).toBe('document');
    }
  });

  it('mirrors the binary categorizer for code (source, configs, unknowns)', () => {
    for (const p of ['index.ts', 'config.json', 'build.sh', 'Dockerfile', '.gitignore', '']) {
      expect(fileTypeGroup(p), p).toBe('code');
    }
  });

  it('every path lands in exactly one group (filter coverage)', () => {
    const paths = ['a.md', 'b.png', 'c.csv', 'd.ts', 'e.unknown', 'Makefile'];
    for (const p of paths) {
      const g = fileTypeGroup(p);
      expect(['document', 'image', 'sheet', 'code']).toContain(g);
    }
  });

  it('labels match the groups', () => {
    expect(fileTypeLabel('plan.md')).toBe('Document');
    expect(fileTypeLabel('logo.png')).toBe('Image');
    expect(fileTypeLabel('data.csv')).toBe('Spreadsheet');
    expect(fileTypeLabel('index.ts')).toBe('Code');
  });
});

// fileKind / previewKind — the tile-and-chip mapping that moved here from the
// attachment-chip mock-up when design C shipped (2026-08-27).
describe('fileKind / previewKind', () => {
  it('buckets by extension, with unknown for anything it cannot vouch for', () => {
    const cases: Array<[string, string]> = [
      ['shot.PNG', 'image'], ['budget.xlsx', 'sheet'], ['data.csv', 'sheet'],
      ['report.docx', 'document'], ['mockup.html', 'document'],
      ['InputBar.ts', 'code'], ['config.json', 'code'], ['build.gradle', 'code'],
      ['notes.txt', 'text'], ['app.log', 'text'],
      ['README.md', 'markdown'], ['spec.markdown', 'markdown'],
      ['invoice.pdf', 'pdf'], ['memo.mp3', 'audio'], ['demo.mp4', 'video'],
      ['assets.zip', 'archive'], ['assets.tar.gz', 'archive'],
      ['sensor-log.dat', 'unknown'], ['Makefile', 'unknown'], ['.gitignore', 'unknown'],
    ];
    for (const [name, kind] of cases) expect(fileKind(`/x/${name}`), name).toBe(kind);
  });

  it('previews only what a tile can cheaply render', () => {
    const cases: Array<[string, string]> = [
      ['shot.png', 'image'], ['photo.JPG', 'image'], ['anim.gif', 'image'], ['hero.webp', 'image'],
      ['icon.svg', 'glyph'], ['fav.ico', 'glyph'],
      ['README.md', 'markdown'],
      ['notes.txt', 'text'], ['InputBar.ts', 'text'], ['data.csv', 'text'], ['app.log', 'text'],
      ['budget.xlsx', 'glyph'], ['invoice.pdf', 'glyph'], ['demo.mp4', 'glyph'],
      ['report.docx', 'glyph'], ['sensor-log.dat', 'glyph'], ['mockup.html', 'glyph'],
    ];
    for (const [name, kind] of cases) expect(previewKind(`C:\\Users\\d\\${name}`), name).toBe(kind);
  });

  it('fileExtension is lowercase, dotless, and empty for dotfiles and bare names', () => {
    expect(fileExtension('/a/b/Report.PDF')).toBe('pdf');
    expect(fileExtension('C:\\a\\.env')).toBe('');
    expect(fileExtension('Makefile')).toBe('');
  });
});
