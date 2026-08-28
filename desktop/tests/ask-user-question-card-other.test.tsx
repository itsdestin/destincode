// @vitest-environment jsdom
/**
 * Ledger G-2 (docs/active/investigations/2026-08-26-native-tools-vs-other-harnesses.md):
 * the AskUserQuestion card offers an "Other" row and a text box per question.
 *   - Other picked → the box is the answer ("Explain…"), required for Submit,
 *     and its text is sent IN PLACE of a label.
 *   - a listed option picked → the box is an optional note ("Add a note…"),
 *     sent as `notes[question]` (and Claude Code's `annotations` shape).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

let respond: ReturnType<typeof vi.fn>;
beforeEach(() => {
  respond = vi.fn().mockResolvedValue(true);
  (window as any).claude = { session: { respondToPermission: respond }, remote: { broadcastAction: vi.fn() } };
});
afterEach(cleanup);

const askTool = (multiSelect = false): ToolCallState => ({
  id: 'tool-q',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which color?', header: 'Color', multiSelect, options: [{ label: 'Blue' }, { label: 'Red' }] }] },
  status: 'awaiting-approval',
  requestId: 'native-q1',
} as ToolCallState);

const renderCard = (tool: ToolCallState) =>
  render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);

const submit = () => screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sentInput = () => respond.mock.calls[0][1].decision.updatedInput;

describe('AskUserQuestion card — Other + note', () => {
  it('offers an Other row after the listed options, and the box reads "Add a note…" until Other is picked', () => {
    renderCard(askTool());
    expect(screen.getByRole('button', { name: /^Other — Type your own answer$/ })).toBeTruthy();
    expect(box().placeholder).toBe('Add a note…');
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    expect(box().placeholder).toBe('Explain…');
  });

  it('Other with nothing typed keeps Submit disabled; typing enables it and the text is sent as the answer', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    expect(submit().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'teal, please' } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('teal, please');
    expect(sentInput().notes).toBeUndefined();
  });

  it('a listed option plus text sends the label as the answer and the text as a note (both shapes)', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.change(box(), { target: { value: 'lighter shade' } });
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('Blue');
    expect(sentInput().notes['Which color?']).toBe('lighter shade');
    expect(sentInput().annotations['Which color?']).toEqual({ notes: 'lighter shade' });
  });

  it('a listed option with an empty box sends no notes at all (unchanged wire shape)', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('Blue');
    expect('notes' in sentInput()).toBe(false);
    expect('annotations' in sentInput()).toBe(false);
  });

  it('multi-select: Other joins the listed labels in the answer list', async () => {
    renderCard(askTool(true));
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    fireEvent.change(box(), { target: { value: 'green' } });
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('Blue, green');
  });

  it('Ctrl+Enter inside the box submits', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.change(box(), { target: { value: 'note' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
  });
});
