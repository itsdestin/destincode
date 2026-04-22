// @vitest-environment jsdom
// desktop/tests/development-popup.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DevelopmentPopup } from '../src/renderer/components/development/DevelopmentPopup';

// WHY: createPortal renders into document.body — cleanup after each test prevents
// DOM accumulation that causes "multiple elements found" errors in subsequent tests.
afterEach(cleanup);

describe('DevelopmentPopup', () => {
  it('renders all three rows', () => {
    render(<DevelopmentPopup open={true} onClose={() => undefined} onOpenBug={() => undefined} onOpenContribute={() => undefined} />);
    expect(screen.getByText(/Report a Bug or Request a Feature/i)).toBeInTheDocument();
    expect(screen.getByText(/Contribute to YouCoded/i)).toBeInTheDocument();
    expect(screen.getByText(/Known Issues and Planned Features/i)).toBeInTheDocument();
  });

  it('opens the GitHub issues URL when Known Issues is clicked', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onClose = vi.fn();
    render(<DevelopmentPopup open={true} onClose={onClose} onOpenBug={() => undefined} onOpenContribute={() => undefined} />);
    fireEvent.click(screen.getByText(/Known Issues and Planned Features/i));
    expect(openSpy).toHaveBeenCalledWith('https://github.com/itsdestin/youcoded/issues', '_blank');
    expect(onClose).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('calls onOpenBug when Report row is clicked', () => {
    const onOpenBug = vi.fn();
    render(<DevelopmentPopup open={true} onClose={() => undefined} onOpenBug={onOpenBug} onOpenContribute={() => undefined} />);
    fireEvent.click(screen.getByText(/Report a Bug or Request a Feature/i));
    expect(onOpenBug).toHaveBeenCalled();
  });
});
