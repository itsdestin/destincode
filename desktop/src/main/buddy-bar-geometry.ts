// WHY a shim: geometry is pure and now shared with the renderer overlay
// (src/shared/buddy-geometry.ts). Main-process callers and the pinning tests
// keep this import path so the move is invisible to them.
export * from '../shared/buddy-geometry';
