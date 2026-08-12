import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// This test verifies that remote-shim.ts exposes the same methods as preload.ts.
// When someone adds a new IPC method to the preload, this test fails until
// the remote-shim is also updated.

describe('Remote shim parity', () => {
  test('remote-shim exposes all preload session methods', () => {
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    const shimSource = fs.readFileSync(
      path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'
    );

    // Extract method names from preload's session object
    const preloadSessionMethods: string[] = [];
    // Pattern: methodName: (...) => or methodName: function
    const methodPattern = /(\w+)\s*:\s*(?:\(|function)/g;

    // Find the session: { ... } block in preload
    const sessionBlock = preloadSource.match(/session:\s*\{([^}]+)\}/s);
    if (sessionBlock) {
      let match;
      while ((match = methodPattern.exec(sessionBlock[1])) !== null) {
        preloadSessionMethods.push(match[1]);
      }
    }

    // Check each preload session method exists in the shim
    const missing = preloadSessionMethods.filter(method => {
      const pattern = new RegExp(`${method}\\s*[:(]`);
      return !pattern.test(shimSource);
    });

    expect(missing).toEqual([]);
  });

  test('remote-shim exposes all preload on.* listener methods', () => {
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    const shimSource = fs.readFileSync(
      path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'
    );

    // Extract method names from preload's on: { ... } block
    const preloadOnMethods: string[] = [];
    const onBlock = preloadSource.match(/on:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
    if (onBlock) {
      const methodPattern = /(\w+)\s*:\s*\(/g;
      let match;
      while ((match = methodPattern.exec(onBlock[1])) !== null) {
        preloadOnMethods.push(match[1]);
      }
    }

    const missing = preloadOnMethods.filter(method => {
      const pattern = new RegExp(`${method}\\s*[:(]`);
      return !pattern.test(shimSource);
    });

    expect(missing).toEqual([]);
  });

  test('loadHistory parameter ORDER matches preload (sessionId, projectSlug, count, all)', () => {
    // Name-presence parity (the tests above) did not catch the 2026-08-12 bug:
    // the shim declared (sessionId, count, all, projectSlug) while preload and
    // every caller use (sessionId, projectSlug, count, all), so the slug landed
    // in `count` and 10 landed in `all` — the server then returned the ENTIRE
    // transcript on every remote history load. Pin the parameter order itself.
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    const shimSource = fs.readFileSync(
      path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'
    );
    const paramOrder = (src: string): string[] | null => {
      const m = src.match(/loadHistory:\s*\(([^)]*)\)/);
      // Strip optional markers and type annotations: "count?: number" -> "count"
      return m ? m[1].split(',').map(p => p.trim().split(/[?:]/)[0].trim()) : null;
    };
    expect(paramOrder(preloadSource)).toEqual(['sessionId', 'projectSlug', 'count', 'all']);
    expect(paramOrder(shimSource)).toEqual(paramOrder(preloadSource));
  });

  test('remote-shim exposes favorites methods', () => {
    const shimSource = fs.readFileSync(
      path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'
    );

    expect(shimSource).toContain('getFavorites');
    expect(shimSource).toContain('setFavorites');
  });
});
