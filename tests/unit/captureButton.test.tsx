import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureButton } from '@/features/scanner/components/CaptureButton';

/**
 * Punch-list item 1 ("dinamismo" on the capture screen): the shutter ring is a
 * decorative, aria-hidden overlay rendered only once a capture has bumped
 * `shutterKey` (its React key, so each shot remounts + re-plays the CSS
 * animation). happy-dom runs no real CSS animation, so these assert the
 * render/wiring contract, not the visual motion.
 */
describe('CaptureButton', () => {
  afterEach(cleanup);

  it('renders no shutter ring at rest (default shutterKey 0)', () => {
    render(<CaptureButton onCapture={vi.fn()} />);
    expect(screen.getByTestId('capture-button')).toBeTruthy();
    expect(screen.queryByTestId('capture-shutter-ring')).toBeNull();
  });

  it('renders the shutter ring once a capture has bumped shutterKey', () => {
    render(<CaptureButton onCapture={vi.fn()} shutterKey={1} />);
    expect(screen.getByTestId('capture-shutter-ring')).toBeTruthy();
  });

  it('calls onCapture on click and is inert while disabled', () => {
    const onCapture = vi.fn();
    const { rerender } = render(<CaptureButton onCapture={onCapture} />);
    fireEvent.click(screen.getByTestId('capture-button'));
    expect(onCapture).toHaveBeenCalledTimes(1);

    rerender(<CaptureButton onCapture={onCapture} disabled />);
    fireEvent.click(screen.getByTestId('capture-button'));
    expect(onCapture).toHaveBeenCalledTimes(1); // still 1 — disabled swallows the click
  });
});
