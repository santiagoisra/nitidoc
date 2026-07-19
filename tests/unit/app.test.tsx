import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 5) unit tests for the `App` shell —
 * "No-scroll immersive shell" (D-3). `ScannerScreen` is mocked out entirely
 * so this suite only exercises the layout decision (`immersive =
 * phase === 'capturing' || phase === 'processing'`), not any of that
 * component's own camera/OpenCV wiring.
 */

vi.mock('@/features/scanner/components/ScannerScreen', () => ({
  ScannerScreen: () => <div data-testid="scanner-screen-stub" />,
}));

import { App } from '@/app/App';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

describe('App shell (Fase 2.3, capture-ux-redesign.md, Unit 5, D-3 "No-scroll scope")', () => {
  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    cleanup();
  });

  it('non-immersive phases (idle) show the header and a scrollable, centered main', () => {
    render(<App />);

    expect(screen.getByTestId('app-header')).toBeTruthy();
    expect(screen.getByText('nitidoc')).toBeTruthy();

    const main = screen.getByTestId('app-main');
    expect(main.className).toContain('overflow-y-auto');
    expect(main.className).toContain('items-center');
    // Review fix (grid-clip regression): `safe center` keeps this same
    // centering for short content but falls back to start-alignment once
    // content overflows, so a tall grid's first row stays reachable.
    expect(main.className).toContain('justify-[safe_center]');
  });

  it.each(['capturing', 'processing', 'adjust'] as const)(
    'immersive phase "%s" hides the header and renders a full-bleed, non-scrolling main',
    (phase) => {
      useScannerStore.setState({ phase });
      render(<App />);

      expect(screen.queryByTestId('app-header')).toBeNull();

      const main = screen.getByTestId('app-main');
      expect(main.className).toContain('overflow-hidden');
      expect(main.className).not.toContain('overflow-y-auto');
      expect(main.className).not.toContain('px-4');
    },
  );

  it.each(['grid', 'editing-corners', 'done'] as const)(
    'non-immersive phase "%s" keeps the header and internal main scroll',
    (phase) => {
      useScannerStore.setState({ phase });
      render(<App />);

      expect(screen.getByTestId('app-header')).toBeTruthy();
      expect(screen.getByTestId('app-main').className).toContain('overflow-y-auto');
    },
  );

  it('the shell root is pinned to the viewport and never scrolls itself', () => {
    render(<App />);

    const shell = screen.getByTestId('app-shell');
    expect(shell.className).toContain('viewport-shell');
    expect(shell.className).toContain('overflow-hidden');
    expect(shell.className).toContain('overscroll-none');
  });
});
