// @vitest-environment jsdom
/**
 * Task 12 (spec R3): the held-ask line a nested SpecialistAskBlock shows once
 * the 5-minute redirect has fired must read differently depending on whether
 * the helper that asked is still running or has already finished — a user
 * answering a held ask for a helper that finished ten minutes ago needs to be
 * told what a Yes actually does now (it reaches the assistant, it does not
 * resume anything). Also pins the pre-existing external-ask explainer this
 * task must not regress.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { SpecialistAskBlock } from '../src/renderer/components/specialists/SpecialistAskBlock';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { SubagentSegment } from '../src/shared/types';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

beforeEach(() => {
  (window as any).claude = {
    session: { respondToPermission: vi.fn().mockResolvedValue(true) },
    remote: { broadcastAction: vi.fn() },
  };
});

afterEach(cleanup);

function segment(over: Partial<ToolSegment> = {}): ToolSegment {
  return {
    type: 'tool',
    id: 'seg-1',
    toolUseId: 'tu-1',
    toolName: 'Bash',
    input: { command: 'echo hi' },
    status: 'awaiting-approval',
    requestId: 'native-req-1',
    ...over,
  };
}

function renderBlock(segOver: Partial<ToolSegment>, runStatus?: 'running' | 'completed' | 'failed' | 'interrupted') {
  return render(
    <ChatProvider>
      <SpecialistAskBlock segment={segment(segOver)} sessionId="s1" specialistName="Wren" runStatus={runStatus} />
    </ChatProvider>,
  );
}

describe('SpecialistAskBlock — held-ask copy', () => {
  it('held + running: says the helper carried on and a Yes still lands as a follow-up', () => {
    renderBlock({ askHeld: true }, 'running');
    const held = screen.getByTestId('nested-ask-held');
    expect(held.textContent).toBe(
      'Wren waited 5 minutes, then carried on without this. Answering Yes now sends it as a follow-up.',
    );
  });

  it('held + finished: says the helper has finished and explains what a Yes does now', () => {
    renderBlock({ askHeld: true }, 'completed');
    const held = screen.getByTestId('nested-ask-held');
    expect(held.textContent).toBe('Wren has already finished. Answering Yes tells the assistant, which can send Wren back out with your answer.');
  });

  it('external (outside-the-folder) ask says the helper has to ask every time — and offers no Always Allow', () => {
    renderBlock({ external: true });
    expect(screen.getByText(/outside the project folder/i).textContent).toBe(
      'This is outside the project folder, so Wren has to ask every time.',
    );
    // Destin's 2026-08-26/27 copy review dropped the "no “Always allow”" clause
    // from the sentence, so this assertion is now the only thing pinning the
    // fact it described: the button is absent, not merely unmentioned.
    expect(screen.queryByRole('button', { name: /always allow/i })).toBeNull();
  });
});
