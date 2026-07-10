import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost, useToast } from '@/shared/ui/ToastHost';

/**
 * Group 6 / PR9 unit tests for `ToastHost` (design section 5.5, task 6.2).
 * Covers the queue + per-toast auto-dismiss timer + `useToast()` contract in
 * isolation from any domain logic (`usePageDeletion` has its own test file).
 */

function ShowToastButton({
  message = 'A toast',
  durationMs,
  action,
}: {
  readonly message?: string;
  readonly durationMs?: number;
  readonly action?: { label: string; onClick: () => void };
}): ReactNode {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast({ message, durationMs, action })}>
      show
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useToast()', () => {
  it('throws when called outside a ToastHost', () => {
    // Render without an act/error boundary — React logs the thrown error to
    // console.error during the render attempt; suppress it for this
    // assertion-only test (the point is that the render itself throws).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ShowToastButton />)).toThrow('useToast() must be called within a <ToastHost>.');
    spy.mockRestore();
  });
});

describe('ToastHost queue + auto-dismiss timer', () => {
  it('renders an enqueued toast and auto-dismisses it after durationMs', () => {
    render(
      <ToastHost>
        <ShowToastButton message="Saved." durationMs={3000} />
      </ToastHost>,
    );

    fireEvent.click(screen.getByText('show'));
    expect(screen.getByText('Saved.')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByText('Saved.')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('applies a default duration when durationMs is omitted', () => {
    render(
      <ToastHost>
        <ShowToastButton message="Default duration" />
      </ToastHost>,
    );

    fireEvent.click(screen.getByText('show'));
    expect(screen.getByText('Default duration')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByText('Default duration')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Default duration')).not.toBeInTheDocument();
  });

  it('renders multiple queued toasts independently, each with its own timer', () => {
    function TwoToasts(): ReactNode {
      const { showToast } = useToast();
      return (
        <>
          <button type="button" onClick={() => showToast({ message: 'First', durationMs: 1000 })}>
            first
          </button>
          <button type="button" onClick={() => showToast({ message: 'Second', durationMs: 5000 })}>
            second
          </button>
        </>
      );
    }

    render(
      <ToastHost>
        <TwoToasts />
      </ToastHost>,
    );

    fireEvent.click(screen.getByText('first'));
    fireEvent.click(screen.getByText('second'));
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('an action button calls its onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <ToastHost>
        <ShowToastButton message="With action" durationMs={5000} action={{ label: 'Undo', onClick }} />
      </ToastHost>,
    );

    fireEvent.click(screen.getByText('show'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('dismissToast removes a toast immediately and cancels its own timer', () => {
    function ShowAndDismiss(): ReactNode {
      const { showToast, dismissToast } = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            const id = showToast({ message: 'Dismiss me', durationMs: 10_000 });
            dismissToast(id);
          }}
        >
          show-and-dismiss
        </button>
      );
    }

    render(
      <ToastHost>
        <ShowAndDismiss />
      </ToastHost>,
    );

    fireEvent.click(screen.getByText('show-and-dismiss'));
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
  });
});
