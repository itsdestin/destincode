import { describe, it, expect } from 'vitest';
import { categorizeArtifact } from '../../src/shared/artifacts/categorization';

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
