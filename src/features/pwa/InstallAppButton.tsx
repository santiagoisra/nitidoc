import type { ReactNode } from 'react';
import { useState } from 'react';
import { Download, Share } from 'lucide-react';
import { Button, Sheet } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { useInstallPrompt } from '@/features/pwa/useInstallPrompt';

/**
 * "Install app" affordance for the Welcome screen. Renders nothing when the app
 * already runs standalone or the platform can't install. On Android/Chromium it
 * fires the native install prompt (one tap); on iOS Safari — which has NO
 * programmatic install — it opens a Sheet with the manual Share → Add to Home
 * Screen steps.
 */
export function InstallAppButton(): ReactNode {
  const { t } = useTranslation();
  const { canInstall, platform, promptInstall } = useInstallPrompt();
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  if (!canInstall) {
    return null;
  }

  const handleClick = (): void => {
    if (platform === 'installable') {
      void promptInstall();
    } else {
      setInstructionsOpen(true);
    }
  };

  return (
    <>
      <Button type="button" variant="ghost" onClick={handleClick} data-testid="install-app">
        <Download size={18} strokeWidth={1.75} aria-hidden="true" />
        {t('install.cta')}
      </Button>

      <Sheet
        open={instructionsOpen}
        onClose={() => setInstructionsOpen(false)}
        title={t('install.iosTitle')}
      >
        <ol className="flex flex-col gap-4">
          <li className="flex items-start gap-3">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary text-[13px] font-bold text-[#0f0e0c]">
              1
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-sm text-text">
              {t('install.iosStep1')}
              <Share size={16} strokeWidth={1.75} className="text-primary" aria-hidden="true" />
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary text-[13px] font-bold text-[#0f0e0c]">
              2
            </span>
            <span className="text-sm text-text">{t('install.iosStep2')}</span>
          </li>
        </ol>
        <p className="mt-5 text-xs text-text-muted">{t('install.iosHint')}</p>
      </Sheet>
    </>
  );
}
