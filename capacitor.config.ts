import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor packaging (history design section 9).
 *
 * Capacitor rather than a Trusted Web Activity, decided by the iOS
 * requirement: a TWA is Android-only with no iOS counterpart, so one codebase
 * for both platforms rules it out. Everything a TWA would have given away for
 * free — installability, `share_target`, Play Billing — the PWA already has on
 * the web, and Capacitor keeps.
 *
 * `webDir: 'dist'` is the ordinary Vite build. Build it with
 * `NITIDOC_NATIVE=1` (see `vite.config.ts`) so the service worker is left out:
 * the app is served from the APK's own assets, so a precaching worker adds
 * nothing but a second, staler copy of every file.
 */
const config: CapacitorConfig = {
  appId: 'com.nitidoc.app',
  appName: 'Nitidoc',
  webDir: 'dist',
  android: {
    // The scanner's whole value is the captured image; letting the WebView
    // resample it down to the device's CSS pixel ratio would defeat that.
    webContentsDebuggingEnabled: true,
  },
  server: {
    // Capacitor serves the bundle over `https://localhost` on Android. That
    // matters far beyond cosmetics: it is a SECURE CONTEXT, which is what
    // `getUserMedia`, `crypto.randomUUID` and IndexedDB persistence all
    // require — the same constraint `vite.config.ts` documents for LAN device
    // testing. It is also why the OpenCV worker's absolute
    // `importScripts('/opencv/opencv.js')` resolves unchanged.
    androidScheme: 'https',
  },
};

export default config;
