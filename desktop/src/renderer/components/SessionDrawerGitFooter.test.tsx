// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GitFooterEntry } from './SessionDrawer';

describe('GitFooterEntry', () => {
  beforeEach(() => {
    (window as any).claude = { git: {} };
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders counts and the Review Changes button when there are changes', () => {
    const onOpen = vi.fn();
    render(<GitFooterEntry counts={{ added: 41, removed: 12 }} show onOpenReview={onOpen} />);
    expect(screen.getByText('+41')).toBeInTheDocument();
    expect(screen.getByText('−12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review Changes' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the button without counts for clean-with-history', () => {
    render(<GitFooterEntry counts={null} show onOpenReview={() => {}} />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review Changes' })).toBeInTheDocument();
  });

  it('renders nothing when show is false', () => {
    const { container } = render(<GitFooterEntry counts={null} show={false} onOpenReview={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
