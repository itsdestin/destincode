import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../src/main/harness/specialists/frontmatter';

// Frontmatter is hand-rolled (no YAML dependency exists in this codebase — every
// config reader here is hand-rolled) and deliberately tolerant: unknown shapes
// become strings rather than throwing, since a specialist file with a typo in
// its frontmatter should still load with a warning, not crash the catalog read.
describe('parseFrontmatter', () => {
  it('parses an inline list', () => {
    const result = parseFrontmatter('---\ntools: [Read, Write, Edit]\n---\nBody text.');
    expect('data' in result && result.data.tools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('parses a block list', () => {
    const raw = '---\ntools:\n  - Read\n  - Write\n---\nBody text.';
    const result = parseFrontmatter(raw);
    expect('data' in result && result.data.tools).toEqual(['Read', 'Write']);
  });

  it('reports a nested map as { nested: true }', () => {
    const raw = '---\nhooks:\n  pre:\n    command: foo\n---\nBody text.';
    const result = parseFrontmatter(raw);
    expect('data' in result && result.data.hooks).toEqual({ nested: true });
  });

  it('joins a folded scalar', () => {
    const raw = '---\ndescription: >\n  This is a long\n  description that wraps.\n---\nBody text.';
    const result = parseFrontmatter(raw);
    expect('data' in result && result.data.description).toBe('This is a long description that wraps.');
  });

  it('accepts CRLF line endings', () => {
    const raw = '---\r\nname: Test\r\n---\r\nBody text.';
    const result = parseFrontmatter(raw);
    expect('data' in result && result.data.name).toBe('Test');
    expect('data' in result && result.body).toBe('Body text.');
  });

  it('strips surrounding quotes', () => {
    const raw = '---\nname: "Docs Writer"\n---\nBody text.';
    const result = parseFrontmatter(raw);
    expect('data' in result && result.data.name).toBe('Docs Writer');
  });

  it('errors when the frontmatter never closes', () => {
    const raw = '---\nname: Test\nBody text with no closing fence.';
    const result = parseFrontmatter(raw);
    expect('error' in result && result.error).toBe('frontmatter never closes (no second ---)');
  });

  it('errors when there is no frontmatter at all', () => {
    const result = parseFrontmatter('Just a plain markdown file with no frontmatter.');
    expect('error' in result).toBe(true);
  });

  it('preserves the body verbatim', () => {
    const raw = '---\nname: Test\n---\n\nLine one.\n\nLine two with   extra   spaces.\n';
    const result = parseFrontmatter(raw);
    expect('data' in result && result.body).toBe('\nLine one.\n\nLine two with   extra   spaces.\n');
  });
});
