// import-failure-message.test.ts
//
// Pins the "+ Add file" import result WORDING — the project's error-message
// standards surface for this flow (docs/error-message-standards.md). Two rules
// it has to keep obeying:
//   - specific and accurate, or general and non-committal; NEVER a guessed
//     cause. Unknown codes fall through carrying the real code + detail.
//   - the sentence names the file the user picked, not whatever path main
//     happened to refuse (for a destination-folder refusal that path is a
//     FOLDER, and a 3-file batch printed the same folder three times).
// Plus the modal title, which used to read "Import failed" over bodies
// reporting a partial success or a plain no-op.
import { describe, it, expect } from 'vitest';
import {
  describeImportFailure,
  importResultTitle,
} from '../src/renderer/components/project-view/ProjectView';

describe('describeImportFailure', () => {
  describe('needs-confirm', () => {
    it('names the picked file AND the protected destination', () => {
      const msg = describeImportFailure(
        { error: 'needs-confirm', detail: '/home/d/proj/.claude' },
        '/home/d/Downloads/settings.json',
      );
      expect(msg).toContain('settings.json');
      expect(msg).toContain('/home/d/proj/.claude');
      expect(msg).toContain('NOT imported');
    });

    it('gives a different line per file in a batch', () => {
      // The destination is the same folder for every file in a batch, so a
      // message built from `detail` alone printed identical lines.
      const lines = ['/a/one.md', '/a/two.md'].map((s) =>
        describeImportFailure({ error: 'needs-confirm', detail: '/home/d/proj/.claude' }, s));
      expect(new Set(lines).size).toBe(2);
    });

    it('stays truthful when no source is available', () => {
      const msg = describeImportFailure({ error: 'needs-confirm', detail: '/p/.env' });
      expect(msg).toContain('That file');
      expect(msg).toContain('/p/.env');
    });
  });

  describe('MOVE_SOURCE_NOT_REMOVED', () => {
    it('reports the PARTIAL outcome — the copy landed, the original stayed', () => {
      const msg = describeImportFailure(
        { error: 'MOVE_SOURCE_NOT_REMOVED', detail: 'EPERM: operation not permitted' },
        '/home/d/Downloads/budget.xlsx',
      );
      expect(msg).toContain('budget.xlsx');
      expect(msg).toContain('copied into the project');
      expect(msg).toContain('both copies exist now');
      // The real OS error is surfaced, not paraphrased into a guess.
      expect(msg).toContain('EPERM: operation not permitted');
      // It must NOT claim the import failed outright — half of it succeeded.
      expect(msg).not.toMatch(/was NOT imported/);
    });

    it('omits the parenthetical when main reported no detail', () => {
      const msg = describeImportFailure({ error: 'MOVE_SOURCE_NOT_REMOVED' }, '/a/notes.md');
      expect(msg).toBe(
        'notes.md was copied into the project, but the original could not be removed — both copies exist now.',
      );
    });
  });

  describe('fallthrough (every other code)', () => {
    it('surfaces the REAL code and detail rather than guessing a cause', () => {
      const msg = describeImportFailure({ error: 'ENOSPC', detail: 'no space left on device' }, '/a/big.iso');
      expect(msg).toContain('big.iso');
      expect(msg).toContain('ENOSPC');
      expect(msg).toContain('no space left on device');
    });

    it('still returns the bare code when there is no detail', () => {
      expect(describeImportFailure({ error: 'COPY_INCOMPLETE' })).toBe('COPY_INCOMPLETE');
    });

    it('does not invent wording for a code it has never seen', () => {
      // A future code must pass through verbatim — anything else would be a
      // hardcoded guess at a cause nobody verified.
      const msg = describeImportFailure({ error: 'EXDEV', detail: 'cross-device link' });
      expect(msg).toBe('EXDEV: cross-device link');
    });
  });
});

describe('importResultTitle', () => {
  it('says failed only when something actually failed', () => {
    expect(importResultTitle({ hardFailures: 1, partial: 0, alreadyInPlace: 0 })).toBe('Import failed');
  });

  it('calls a half-done move partly finished, not failed', () => {
    // The body reads "copied into the project, but the original could not be
    // removed" — titling that "Import failed" contradicted its own text.
    expect(importResultTitle({ hardFailures: 0, partial: 1, alreadyInPlace: 0 }))
      .toBe('Import partly finished');
  });

  it('calls a self-import no-op nothing to import', () => {
    expect(importResultTitle({ hardFailures: 0, partial: 0, alreadyInPlace: 2 }))
      .toBe('Nothing to import');
  });

  it('a real failure outranks a partial or a no-op in the same batch', () => {
    expect(importResultTitle({ hardFailures: 1, partial: 1, alreadyInPlace: 1 })).toBe('Import failed');
    expect(importResultTitle({ hardFailures: 0, partial: 1, alreadyInPlace: 1 }))
      .toBe('Import partly finished');
  });
});
