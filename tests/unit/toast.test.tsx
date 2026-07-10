import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast } from '@/shared/ui/Toast';

/**
 * Group 6 / PR9 unit tests for `Toast`'s Fase 2 additive props (design
 * section 5.5, task 6.1): `action` renders a clickable button and forwards
 * `onClick`; the primitive itself never times or removes anything (that is
 * `ToastHost`'s job, covered in `toastHost.test.tsx`) — `durationMs` is
 * accepted on the props type but is not read by `Toast` itself.
 */

afterEach(() => {
  cleanup();
});

describe('Toast (Fase 1 baseline, unchanged)', () => {
  it('renders the message with no action button when none is given', () => {
    render(<Toast message="Hello" />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Toast action (Fase 2 additive prop, design section 5.5)', () => {
  it('renders the action label as a button and calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(<Toast message="Page removed." action={{ label: 'Undo', onClick }} />);

    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('accepts durationMs on the props type without rendering or using it directly', () => {
    // durationMs is consumed by ToastHost, not Toast itself — this merely
    // proves the additive prop does not break the existing primitive.
    render(<Toast message="Times out later" durationMs={5000} />);
    expect(screen.getByText('Times out later')).toBeInTheDocument();
  });
});
