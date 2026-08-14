import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeScreen } from '@/features/scanner/components/WelcomeScreen';
import { LocaleProvider } from '@/shared/i18n';

/**
 * AGPL section 13 compliance guard. Nitidoc is served over a network, so its
 * users must be offered the corresponding source — the welcome screen link is
 * that offer. A refactor that drops it is a licence violation, not a cosmetic
 * regression, which is why it gets its own test.
 *
 * `InstallAppButton` is mocked away: it sniffs the platform and captures
 * `beforeinstallprompt`, neither of which this contract depends on (it has its
 * own suite in installAppButton.test.tsx).
 */

vi.mock('@/features/pwa/InstallAppButton', () => ({
  InstallAppButton: (): null => null,
}));

const noop = (): void => {};
const noopImport = async (): Promise<void> => {};

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('nitidoc.locale');
});

describe('WelcomeScreen — AGPL source offer', () => {
  it('keeps paper selection out of Welcome and imports as free-form original', async () => {
    const onImportFile = vi.fn(async () => {});
    render(<WelcomeScreen onStart={noop} onImportFile={onImportFile} />);

    expect(screen.queryByTestId('welcome-paper-format')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Paper size' })).toBeNull();

    const file = new File(['image'], 'receipt.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('welcome-import-input'), { target: { files: [file] } });

    await waitFor(() => expect(onImportFile).toHaveBeenCalledWith(file));
  });

  it('links to the public repository, opening safely in a new tab', () => {
    render(<WelcomeScreen onStart={noop} onImportFile={noopImport} />);

    const link = screen.getByTestId('welcome-source-link');
    expect(link).toHaveAttribute('href', 'https://github.com/santiagoisra/nitidoc');
    expect(link).toHaveAttribute('target', '_blank');
    // Without noopener the opened tab can reach back through window.opener.
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('names the licence in both locales', () => {
    // LocaleProvider resolves its locale from localStorage on mount.
    window.localStorage.setItem('nitidoc.locale', 'en');
    const { unmount } = render(
      <LocaleProvider>
        <WelcomeScreen onStart={noop} onImportFile={noopImport} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('welcome-source-link')).toHaveTextContent('Open source · AGPL-3.0');
    unmount();

    window.localStorage.setItem('nitidoc.locale', 'es');
    render(
      <LocaleProvider>
        <WelcomeScreen onStart={noop} onImportFile={noopImport} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('welcome-source-link')).toHaveTextContent('Código abierto · AGPL-3.0');
  });
});
