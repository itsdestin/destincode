// @vitest-environment jsdom
// Pins the inline-reply render (spec 2026-07-26 §2): a message whose content
// is a reference scaffold renders as a quoted strip + follow-up, not the raw
// scaffold string. A plain message renders exactly as before.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import UserMessage from './UserMessage';
import { buildScaffold, buildArtifactScaffold, LEAD_ASSISTANT, LEAD_CODE } from './context-menu/reference-prompt';
import type { ChatMessage } from '../../shared/types';

afterEach(cleanup);

function msg(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'user', content, timestamp: 1000, ...overrides };
}

describe('UserMessage — plain messages are untouched', () => {
  it('renders ordinary typed text as before, no reply chrome', () => {
    const { container } = render(
      <UserMessage message={msg('what is the plan for today?')} sessionId="s1" showTimestamps={false} />,
    );
    expect(container.textContent).toContain('what is the plan for today?');
    expect(container.querySelector('.border-l-2')).toBeNull();
  });

  it('does not treat a message that merely mentions the marker text as a reference', () => {
    const { container } = render(
      <UserMessage
        message={msg('I saw "The user has a follow-up: " in the code somewhere')}
        sessionId="s1"
        showTimestamps={false}
      />,
    );
    expect(container.querySelector('.border-l-2')).toBeNull();
  });
});

describe('UserMessage — chat-text reference renders as an inline reply', () => {
  const content = buildScaffold(LEAD_ASSISTANT, 'Done! Created a test file.', false) + "what's in it?";

  it('renders the quote and the follow-up, not the raw scaffold', () => {
    render(<UserMessage message={msg(content)} sessionId="s1" showTimestamps={false} />);
    expect(screen.getByText('Done! Created a test file.')).toBeInTheDocument();
    expect(screen.getByText("what's in it?")).toBeInTheDocument();
    // The raw lead-in string must not appear verbatim as its own text node —
    // it's consumed by the parser, not dumped into the bubble.
    expect(screen.queryByText(LEAD_ASSISTANT, { exact: false })).toBeNull();
  });

  it('a short quote has no show more/less toggle', () => {
    render(<UserMessage message={msg(content)} sessionId="s1" showTimestamps={false} />);
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
  });
});

describe('UserMessage — chat-code reference renders monospaced', () => {
  it('renders the fenced code monospaced once expanded', () => {
    const content = buildScaffold(LEAD_CODE, 'const x = 1;', true) + 'what does x do?';
    const { container } = render(<UserMessage message={msg(content)} sessionId="s1" showTimestamps={false} />);
    // Collapsed by default (pill); the quote text is present in the pill but the
    // monospace treatment belongs to the expanded panel.
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(container.querySelector('.font-mono')).not.toBeNull();
  });
});

describe('UserMessage — artifact reference renders a compact descriptor line', () => {
  it('renders the descriptor as a static pill with no toggle', () => {
    const content = buildArtifactScaffold('lines 12-14', 'src/state/chat-reducer.ts') + 'what happens here?';
    render(<UserMessage message={msg(content)} sessionId="s1" showTimestamps={false} />);
    // Renders as the same pill shape as a quote, but static — an artifact
    // reference is already a short descriptor, so it never expands.
    expect(screen.getByText(/lines 12-14 of chat-reducer\.ts/)).toBeInTheDocument();
    expect(screen.getByText('what happens here?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });
});

describe('UserMessage — reference collapses to a pill and expands to a panel', () => {
  const longQuote = 'x'.repeat(300);
  const content = buildScaffold(LEAD_ASSISTANT, longQuote, false) + 'ok';

  it('is collapsed to a pill by default, so the bubble stays the size of what was typed', () => {
    render(<UserMessage message={msg(content)} sessionId="s1" showTimestamps={false} />);
    const pill = screen.getByRole('button', { expanded: false });
    expect(pill).toBeInTheDocument();
    expect(pill.tagName).toBe('BUTTON');   // routes through the Button primitive
    // The panel's label only exists once expanded.
    expect(screen.queryByText(/claude said/i)).toBeNull();
  });

  it('expands into the labelled panel, then collapses again', () => {
    render(<UserMessage message={msg(content)} sessionId="s1" showTimestamps={false} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText(/claude said/i)).toBeInTheDocument();
    expect(screen.getByText(longQuote)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hide/i }));
    expect(screen.queryByText(/claude said/i)).toBeNull();
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
  });

  it('a SHORT quote collapses too — the pill is unconditional, not length-gated', () => {
    const short = buildScaffold(LEAD_ASSISTANT, 'tiny quote', false) + 'ok';
    render(<UserMessage message={msg(short)} sessionId="s1" showTimestamps={false} />);
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
  });
});
