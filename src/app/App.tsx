import type { ReactNode } from 'react';
import { ScanLine } from 'lucide-react';
import { Button } from '@/shared/ui';

/**
 * App shell — Fase 1 has a single screen (the scanner), no router.
 * The actual camera viewfinder / detection UI is wired in Groups 3-4;
 * this slice only establishes the dark-first shell layout.
 */
export function App(): ReactNode {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg text-text">
      <header className="flex items-center gap-3 border-b border-text-muted/10 px-4 py-4">
        <ScanLine size={24} strokeWidth={1.5} className="text-primary" aria-hidden="true" />
        <span className="text-lg font-semibold tracking-tight">Nitidoc</span>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-8">
        <p className="max-w-sm text-center text-sm text-text-muted">
          Scanner viewfinder, live detection and capture UI are implemented in later slices.
        </p>
        <Button variant="primary" type="button" disabled>
          Open scanner
        </Button>
      </main>
    </div>
  );
}
