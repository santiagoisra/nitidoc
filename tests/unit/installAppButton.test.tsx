import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallAppButton } from '@/features/pwa/InstallAppButton';
import type { InstallPromptState } from '@/features/pwa/useInstallPrompt';

/**
 * Tests for the landing-page install deep link (`app.nitidoc.com/?install=1`,
 * the "Instalar en tu teléfono" button). `useInstallPrompt` is mocked: UA
 * sniffing and Chromium's `beforeinstallprompt` capture have no DOM-test
 * equivalent — the contract under test is the component's reaction to an
 * already-resolved platform plus the one-shot consumption of the param.
 */

let mockState: InstallPromptState;

vi.mock('@/features/pwa/useInstallPrompt', () => ({
  // Lazy read so each test can swap `mockState` before rendering.
  useInstallPrompt: (): InstallPromptState => mockState,
}));

function setUrl(url: string): void {
  window.history.replaceState(null, '', url);
}

beforeEach(() => {
  mockState = { canInstall: true, platform: 'ios', promptInstall: vi.fn() };
});

afterEach(() => {
  cleanup();
  setUrl('/');
});

describe('InstallAppButton — ?install=1 deep link', () => {
  it('opens the iOS instructions sheet on mount and strips the param', () => {
    setUrl('/?install=1');
    render(<InstallAppButton />);

    // Bare render (no <LocaleProvider>) resolves to the English dictionary.
    expect(screen.getByRole('dialog', { name: 'Install Nitidoc on your iPhone' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('does not open the sheet when the param is absent', () => {
    render(<InstallAppButton />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('consumes the param WITHOUT auto-firing the native prompt on Chromium', () => {
    setUrl('/?install=1&utm_source=landing');
    mockState = { canInstall: true, platform: 'installable', promptInstall: vi.fn() };
    render(<InstallAppButton />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // prompt() needs a user gesture from THIS page — the deep link must not
    // call it; the visible install button is the Chromium flow.
    expect(mockState.promptInstall).not.toHaveBeenCalled();
    // Unrelated query params survive the cleanup.
    expect(window.location.search).toBe('?utm_source=landing');
  });

  it('a reload after the sheet was dismissed does not reopen it (param already consumed)', () => {
    setUrl('/?install=1');
    const first = render(<InstallAppButton />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    first.unmount();

    // Same (now-clean) URL, fresh mount — simulates the user reloading.
    render(<InstallAppButton />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
