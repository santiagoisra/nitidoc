/**
 * Welcome screen (HANDOFF-UI.md section 5.1) — the `!started` branch of
 * `ScannerScreen`, replacing the bare "Abrir escáner" button. A centered
 * layout: a floating document illustration (pure CSS), a large circular CTA
 * (teal gradient + breathing halo rings) that opens the camera directly, and
 * an "Importar imagen" ghost pill below.
 *
 * The CTA keeps `data-testid="open-scanner"` — the E2E suite opens the
 * scanner through it, so the id must survive this redesign (handoff section 6:
 * "Los tests E2E dependen de data-testid — no tocarlos").
 *
 * Import wiring: the file picker hands the chosen file up via `onImportFile`
 * (ScannerScreen decodes → materializes → jumps to processing). Decode/
 * materialize failures reject that promise and surface inline here without
 * leaving the welcome screen.
 */

import type { ChangeEvent, ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';
import { Button, BrandGlyph } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { InstallAppButton } from '@/features/pwa/InstallAppButton';

/** Where the AGPL section 13 source offer points. */
const SOURCE_URL = 'https://github.com/santiagoisra/nitidoc';

export interface WelcomeScreenProps {
  /** Opens the camera directly (ScannerScreen's `handleStart`). */
  readonly onStart: () => void;
  /** Decodes + materializes an imported image and advances to processing. Rejects on failure. */
  readonly onImportFile: (file: File) => Promise<void>;
}

export function WelcomeScreen({ onStart, onImportFile }: WelcomeScreenProps): ReactNode {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handlePickFile = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so re-picking the SAME file still fires `change`.
      event.target.value = '';
      if (!file) return;
      setImportError(null);
      setImporting(true);
      try {
        await onImportFile(file);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : t('scanner.couldNotReadImage'));
      } finally {
        setImporting(false);
      }
    },
    [onImportFile, t],
  );

  return (
    <div className="flex w-full max-w-md flex-1 flex-col items-center justify-center gap-8 py-6" data-testid="welcome-screen">
      {/* Floating document illustration — pure CSS. A warm paper card with
          visible "written" lines, gently floating over a soft shadow. */}
      <div className="animate-float relative flex h-44 w-full items-center justify-center" aria-hidden="true">
        <div className="absolute h-36 w-28 -rotate-6 rounded-lg bg-surface shadow-[0_18px_40px_rgba(0,0,0,0.45)]" />
        <div className="relative flex h-36 w-28 rotate-3 flex-col gap-2 rounded-lg bg-surface-light p-4 shadow-[0_22px_50px_rgba(0,0,0,0.5)]">
          <span className="h-2 w-2/3 rounded-full bg-primary" />
          <span className="h-1.5 w-full rounded-full bg-[#d7d0c4]" />
          <span className="h-1.5 w-full rounded-full bg-[#d7d0c4]" />
          <span className="h-1.5 w-5/6 rounded-full bg-[#d7d0c4]" />
          <span className="h-1.5 w-full rounded-full bg-[#d7d0c4]" />
          <span className="h-1.5 w-3/4 rounded-full bg-[#d7d0c4]" />
          <span className="mt-1 h-1.5 w-1/2 rounded-full bg-[#e2ddd3]" />
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-extrabold tracking-tight text-text">{t('welcome.cta')}</h1>
        <p className="max-w-[16rem] text-sm text-text-muted">{t('welcome.hint')}</p>
      </div>

      {/* Primary CTA — an unmistakable pill button (icon + label). The old
          icon-only circle read as decoration; this reads as "tap here". A soft
          breathing halo behind keeps the delight. */}
      <div className="relative">
        <span
          className="animate-breath pointer-events-none absolute inset-0 rounded-full bg-primary/50 blur-lg"
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={onStart}
          data-testid="open-scanner"
          className="relative flex items-center gap-3 rounded-full px-8 py-4 text-white
            shadow-[0_12px_34px_rgba(15,138,120,0.5)] transition-transform duration-150 ease-out
            hover:scale-[1.03] active:scale-95
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light focus-visible:ring-offset-4 focus-visible:ring-offset-bg"
          style={{ backgroundImage: 'linear-gradient(140deg, #3AD6BD, #0F8A78)' }}
        >
          <BrandGlyph size={26} withBackground={false} className="text-white" />
          <span className="text-lg font-bold">{t('welcome.openCamera')}</span>
        </button>
      </div>

      <div className="flex flex-col items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => void handleFileChange(event)}
          data-testid="welcome-import-input"
        />
        <Button type="button" variant="ghost" onClick={handlePickFile} disabled={importing} data-testid="welcome-import">
          {importing ? t('common.processing') : t('import.importImage')}
        </Button>
        {importError && (
          <p role="alert" className="text-sm text-danger" data-testid="welcome-import-error">
            {importError}
          </p>
        )}
      </div>

      {/* Install-as-app affordance — self-hides when already installed or when
          the platform can't install (see InstallAppButton / useInstallPrompt). */}
      <InstallAppButton />

      {/* AGPL section 13: users interacting with this app over a network must be
          offered its source. This link is that offer, so it has to stay
          reachable from the entry screen. */}
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="welcome-source-link"
        className="text-xs text-text-muted underline decoration-text-muted/40 underline-offset-4
          transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-primary-light focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {t('welcome.sourceCode')}
      </a>
    </div>
  );
}
