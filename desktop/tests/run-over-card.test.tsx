// @vitest-environment jsdom
// desktop/tests/run-over-card.test.tsx
//
// Destin, 2026-08-31: "single-player/high-score games should have a clear
// end/failure screen with a retry button."
//
// WHY these are worth pinning: Flappy and 2048 had each grown their own end
// overlay and they had ALREADY drifted — Flappy celebrated a new best, 2048
// silently did not. Same achievement, different reward, for no reason anyone
// chose. The card is now shared; these hold it that way.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import RunOverCard from '../src/renderer/components/game/RunOverCard';

afterEach(cleanup);

describe('the end of a run', () => {
  it('leads with the score, not the failure', () => {
    // A high-score game is asking you to beat a number, so the number is the
    // headline and the cause is the footnote.
    render(<RunOverCard reason="You hit a pipe" score="17 pipes" isBest={false} onRetry={vi.fn()} />);
    const score = screen.getByText('17 pipes');
    const reason = screen.getByText('You hit a pipe');
    expect(score.className).toMatch(/text-2xl/);
    expect(reason.className).toMatch(/text-2xs/);
  });

  it('always offers a retry', () => {
    const onRetry = vi.fn();
    render(<RunOverCard reason="No moves left" score="12,480" isBest={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Play again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('celebrates a new best', () => {
    render(<RunOverCard reason="You hit a pipe" score="31 pipes" isBest onRetry={vi.fn()} />);
    expect(screen.getByText('New best')).toBeInTheDocument();
  });

  it('shows the target to beat when the run fell short', () => {
    // Not a scolding — the reason to press again.
    render(<RunOverCard reason="You hit a pipe" score="9 pipes" isBest={false} best="31 pipes" onRetry={vi.fn()} />);
    expect(screen.getByText(/Your best: 31 pipes/)).toBeInTheDocument();
    expect(screen.queryByText('New best')).toBeNull();
  });

  it('names the key that retries, for a keyboard game', () => {
    render(<RunOverCard reason="x" score="1" isBest={false} onRetry={vi.fn()} retryKeyHint="Space" />);
    expect(screen.getByText(/press Space/i)).toBeInTheDocument();
  });

  it('offers a way out, not only a way back in', () => {
    const onExit = vi.fn();
    render(<RunOverCard reason="x" score="1" isBest={false} onRetry={vi.fn()} onExit={onExit} />);
    fireEvent.click(screen.getByText('Back to games'));
    expect(onExit).toHaveBeenCalled();
  });
});

describe('every solo game ends the same way', () => {
  // The drift this replaced was invisible until someone played both games.
  // A source scan is what makes a THIRD game inherit the rule instead of
  // re-inventing a fourth ending.
  const DIR = join(__dirname, '..', 'src', 'renderer', 'components', 'game');

  function soloGameFiles(): string[] {
    const files = readdirSync(DIR).filter((f) => /Game\.tsx$/.test(f) && f !== 'RunOverCard.tsx');
    expect(files.length, 'no solo games found — the scan is looking in the wrong place').toBeGreaterThanOrEqual(2);
    return files;
  }

  it('uses the shared card rather than a hand-rolled overlay', () => {
    for (const f of soloGameFiles()) {
      expect(readFileSync(join(DIR, f), 'utf8'), f).toContain('RunOverCard');
    }
  });

  it('offers a keyboard retry', () => {
    // A keyboard game whose retry is mouse-only breaks its own contract.
    for (const f of soloGameFiles()) {
      expect(readFileSync(join(DIR, f), 'utf8'), f).toContain('retryKeyHint');
    }
  });
});
