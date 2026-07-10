import type { ReactNode } from 'react';
import { ScanLine } from 'lucide-react';
import { ToastHost } from '@/shared/ui';
import { ScannerScreen } from '@/features/scanner/components/ScannerScreen';

/**
 * App shell — Fase 1 has a single screen (the scanner), no router.
 * Live detection overlay, auto-capture, and the corner editor are wired in
 * Groups 4-5; this slice wires the camera viewfinder itself (Group 3).
 *
 * Group 6/PR9 (design section 5.5): `ToastHost` is mounted once here, at the
 * app root, so `useToast()` (used by `usePageDeletion`'s 5s undo toast) is
 * available anywhere in the tree without disrupting the existing layout —
 * it renders `children` untouched plus its own fixed toast queue overlay.
 */
export function App(): ReactNode {
  return (
    <ToastHost>
      <div className="flex min-h-[100dvh] flex-col bg-bg text-text">
        <header className="flex items-center gap-3 border-b border-text-muted/10 px-4 py-4">
          <ScanLine size={24} strokeWidth={1.5} className="text-primary" aria-hidden="true" />
          <span className="text-lg font-semibold tracking-tight">Nitidoc</span>
        </header>

        <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-8">
          <ScannerScreen />
        </main>
      </div>
    </ToastHost>
  );
}
