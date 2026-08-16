// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import InjectedNoticeBubble from './InjectedNoticeBubble';

afterEach(cleanup);

// 2026-08-16 (Destin, 1b hands-on): a delivered specialist report is a
// user-ROLE turn on the wire (the parent model reads it), and it used to
// render as the user's own accent bubble — "you typed this" about words the
// user never wrote. This pins the notice presentation.
describe('InjectedNoticeBubble', () => {
  const message = {
    id: 'm1', role: 'user' as const, timestamp: 1_700_000_000_000,
    content: '[Background specialist finished] Briar the Worthy Worker (worker) completed the task.\n\n## Report from Briar the Worthy Worker (worker)\n\n- Created and deleted the marker file.',
  };

  it('renders left-aligned as a labelled system notice, never as a user bubble', () => {
    const { container } = render(
      <InjectedNoticeBubble message={message} injected="specialist-report" sessionId="s1" showTimestamps={false} />,
    );
    const notice = screen.getByTestId('injected-notice');
    expect(notice).toHaveAttribute('data-injected', 'specialist-report');
    // Left side (assistant-style), and NOT the user's accent bubble.
    expect(notice.className).toContain('justify-start');
    expect(container.querySelector('.user-bubble')).toBeNull();
    expect(container.querySelector('.assistant-bubble')).not.toBeNull();
    // Labelled for what it is.
    expect(screen.getByText('Specialist report')).toBeInTheDocument();
    // Body is markdown-rendered: the `##` heading becomes a real heading, not raw text.
    expect(container.querySelector('h2')?.textContent).toContain('Report from Briar the Worthy Worker');
    expect(container.textContent).not.toContain('## Report');
  });

  it('gives an unknown injected kind a truthful generic label instead of a user bubble', () => {
    render(<InjectedNoticeBubble message={message} injected="something-new" sessionId="s1" showTimestamps={false} />);
    expect(screen.getByText('System message')).toBeInTheDocument();
  });
});
