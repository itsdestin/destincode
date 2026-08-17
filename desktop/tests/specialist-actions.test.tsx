// @vitest-environment jsdom
/**
 * Task 12: the note box's 2,000-character cap. The box gave no indication of
 * the limit until the send actually failed — this pins the honest counter
 * (reads the real length at every length, including past the cap) and the
 * disabled Send that gates it, plus that a backend refusal's error text is
 * shown verbatim (never paraphrased).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { SpecialistActions } from '../src/renderer/components/specialists/SpecialistActions';
import type { ToolCallState } from '../src/shared/types';

afterEach(cleanup);

const run: NonNullable<ToolCallState['specialistRun']> = {
  childId: 'child-1',
  parentToolCallId: 'tool-1',
  agentType: 'explorer',
  title: 'Wren the Whistling Worker',
  background: false,
  status: 'running',
  startedAt: Date.now(),
};

function openNoteBox() {
  render(<SpecialistActions sessionId="s1" run={run} />);
  fireEvent.click(screen.getByRole('button', { name: /send wren a note/i }));
  return screen.getByPlaceholderText(/wren should know/i);
}

describe('SpecialistActions — note cap', () => {
  beforeEach(() => {
    (window as any).claude = { specialists: { steer: vi.fn(), interrupt: vi.fn() } };
  });

  it('the counter shows N / 2,000 and Send is disabled past 2,000', () => {
    const textarea = openNoteBox();
    const over = 'a'.repeat(2001);
    fireEvent.change(textarea, { target: { value: over } });
    expect(screen.getByText('2,001 / 2,000')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();

    // Under the cap the counter still reads honestly and Send re-enables —
    // this is the control proving the button isn't just disabled forever.
    fireEvent.change(textarea, { target: { value: 'a short note' } });
    expect(screen.getByText('12 / 2,000')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled();
  });

  it('never truncates a paste past the cap — no maxLength on the textarea', () => {
    const textarea = openNoteBox();
    expect(textarea.hasAttribute('maxlength')).toBe(false);
  });

  it('a backend {ok:false,error} shows the error text verbatim', async () => {
    const steer = vi.fn().mockResolvedValue({ ok: false, error: 'The helper already finished — nothing to steer.' });
    (window as any).claude = { specialists: { steer, interrupt: vi.fn() } };
    const textarea = openNoteBox();
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    const err = await screen.findByText('The helper already finished — nothing to steer.');
    expect(err.textContent).toBe('The helper already finished — nothing to steer.');
  });
});
