import { useEffect, useState } from 'react';

/**
 * The non-standard `beforeinstallprompt` event (Chromium only). It is not part
 * of the TS DOM lib, so we type it locally and augment `WindowEventMap` below.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

export type InstallPlatform = 'installable' | 'ios' | 'unsupported';

export interface InstallPromptState {
  /** Whether to render any install affordance (false once installed / unsupported). */
  readonly canInstall: boolean;
  /** 'installable' → native prompt available; 'ios' → manual Share→Add-to-Home flow. */
  readonly platform: InstallPlatform;
  /** Fires the native install prompt (Chromium). No-op on iOS / when unavailable. */
  readonly promptInstall: () => Promise<void>;
}

/**
 * Chrome fires `beforeinstallprompt` EARLY — often before React mounts. We latch
 * it at module-eval time (this module is pulled into the initial shell through
 * WelcomeScreen) so the event is never missed, then fan out to hook subscribers.
 */
let capturedPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress Chrome's default mini-infobar; installation is driven by our button.
    event.preventDefault();
    capturedPrompt = event;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    capturedPrompt = null;
    installed = true;
    notify();
  });
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ masquerades as Mac; a touch-capable "MacIntel" is really an iPad.
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Drives the "Install app" affordance: whether to show it, which flow to use
 * (native prompt vs iOS instructions), and a trigger for the native prompt.
 * Auto-hides once the app runs standalone (already installed).
 */
export function useInstallPrompt(): InstallPromptState {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const rerender = (): void => forceRender((n) => n + 1);
    subscribers.add(rerender);
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  const standalone = installed || isStandalone();
  let platform: InstallPlatform = 'unsupported';
  if (capturedPrompt) {
    platform = 'installable';
  } else if (isIos()) {
    platform = 'ios';
  }

  const canInstall = !standalone && platform !== 'unsupported';

  const promptInstall = async (): Promise<void> => {
    if (!capturedPrompt) return;
    // A prompt can only be used once; clear it before awaiting so the button
    // can't double-fire, and hide the affordance regardless of the choice.
    const event = capturedPrompt;
    capturedPrompt = null;
    notify();
    await event.prompt();
  };

  return { canInstall, platform, promptInstall };
}
