import type { TranslationValue } from '@/shared/i18n/types';

/**
 * Canonical English dictionary — also the fallback used by `useTranslation()`
 * when called WITHOUT a `<LocaleProvider>` ancestor (see `LocaleProvider.tsx`
 * doc comment), which keeps existing English-based test assertions/
 * aria-label selectors passing without wrapping every test.
 *
 * `keyof typeof en` is the single source of truth for `TranslationKey`
 * (`translate.ts`) — `es.ts` is type-checked against this same key set via
 * `satisfies Record<keyof typeof en, TranslationValue>`, so a missing
 * Spanish translation is a COMPILE error, not a silent runtime fallback.
 */
export const en = {
  'common.back': 'Back',
  'common.close': 'Close',
  'common.processing': 'Processing…',
  'common.documentLimitReached': 'Document limit reached ({cap} pages).',

  'lang.toggle': 'Switch language',

  'welcome.cta': 'Scan document',
  'welcome.openCamera': 'Open camera',
  'welcome.hint': 'Tapping opens the camera directly',
  'welcome.sourceCode': 'Open source · AGPL-3.0',

  'scanner.openScanner': 'Open scanner',
  'scanner.cameraError': 'Could not open the camera. Try again, or import an image instead.',
  'scanner.loading': 'Loading…',
  'scanner.scanComplete': { one: 'Scan complete — {n} page.', other: 'Scan complete — {n} pages.' },
  'scanner.scanAnother': 'Scan another document',
  'scanner.couldNotReadImage': 'Could not read the selected image.',
  'scanner.toggleTorch': 'Toggle torch',
  'scanner.exportPdf': 'Export PDF',
  'scanner.exporting': 'Exporting…',
  'scanner.exportPdfError': 'Could not export PDF.',

  'editor.cornerHandle': 'Corner handle {n}',
  'editor.convexWarning': 'Corners must form a convex shape. Adjust a handle to continue.',
  'editor.rotate': 'Rotate 90 degrees',
  'editor.flipHorizontal': 'Flip horizontal',
  'editor.processError': 'Could not process the image. Adjust a corner to retry.',
  'editor.back': 'Back',
  'editor.next': 'Next',
  'editor.confirm': 'Confirm',
  'editor.aspectA4': 'A4',
  'editor.aspectLetter': 'Letter',
  'editor.aspectTicket': 'Ticket',
  'editor.aspectOriginal': 'Original',

  'adjust.retake': 'Retake',
  'adjust.rotateLeft': 'Left',
  'adjust.crop': 'Crop',
  'adjust.next': 'Next',
  'adjust.addMore': 'Add more',
  'adjust.prevPage': 'Previous page',
  'adjust.nextPage': 'Next page',
  'adjust.cropChip': 'Adjust edges',
  'adjust.cropDone': 'Done',
  'adjust.cropCancel': 'Cancel',

  'filter.title': 'Filters',
  'filter.presetOriginal': 'Original',
  'filter.presetEnhanced': 'Enhanced',
  'filter.presetGrayscale': 'Grayscale',
  'filter.presetBw': 'B&W',
  'filter.presetBwHighContrast': 'B&W high contrast',
  'filter.presetEco': 'Eco',
  'filter.brightness': 'Brightness',
  'filter.contrast': 'Contrast',
  'filter.sharpness': 'Sharpness',
  'filter.applyToAll': 'Apply to all pages',
  'filter.applyToAllConfirmText': 'Apply this filter to every page? Individual filters will be overwritten.',
  'filter.cancel': 'Cancel',
  'filter.applyToAllConfirmButton': 'Apply to all',

  'capture.pagesCaptured': { one: '{n} page captured', other: '{n} pages captured' },
  'capture.done': 'Done',
  'capture.captureDocument': 'Capture document',
  'capture.pageRemoved': 'Page removed.',
  'capture.undo': 'Undo',
  'capture.next': 'Next',
  'capture.retakeLast': 'Retake last capture',
  'capture.captureFailed': 'Could not capture the page. Try again.',
  'capture.importAnother': 'Import another',

  'processing.title': 'Processing your pages…',
  'processing.subtitle': 'Detecting edges and correcting perspective',
  'processing.progress': '{done} of {total}',
  'processing.failedPages': 'Could not process any page. Try again.',
  'processing.cancel': 'Cancel',

  'grid.title': 'Document',
  'grid.pageCount': { one: '{n} page', other: '{n} pages' },
  'grid.reorderHint': 'Drag the handle to reorder',
  'grid.reorder': 'Reorder page',
  'grid.pagesCaptured': { one: '{n} page captured.', other: '{n} pages captured.' },
  'grid.captureMore': 'Capture more',
  // "Done" rather than "Finish": this screen reviews the document, it does not
  // end the flow — the done screen after it still offers view/export.
  'grid.finish': 'Done',
  'grid.deletePage': 'Delete page',
  'grid.needsReview': 'Review',
  'grid.editPage': 'Edit page',
  'grid.emptyCta': 'Capture',

  'done.title': 'Document ready!',
  'done.pagesScanned': { one: '{n} page scanned', other: '{n} pages scanned' },

  'import.instructionsFirefox':
    'Open the padlock icon in the address bar, set Camera to "Allow", then reload the page.',
  'import.instructionsLockIcon':
    'Click the lock/info icon in the address bar, set Camera to "Allow", then reload the page.',
  'import.instructionsSafari': 'Open Safari Settings > Websites > Camera, allow this site, then reload the page.',
  'import.cameraAccessDenied': 'Camera access was denied.',
  'import.noCameraDetected':
    'No camera was detected on this device. You can still scan a document by importing an image file.',
  'import.importImage': 'Import image',
  'import.importADocumentImage': 'Import a document image',
  'import.processingStatus': 'Processing the selected image, please wait.',

  'opencv.unavailable':
    'Document detection is unavailable right now{error}. You can still capture a photo and adjust its corners manually.',
  'opencv.retry': 'Retry',

  'camera.selectCamera': 'Select camera',
  'camera.cameraN': 'Camera {n}',

  'install.cta': 'Install app',
  'install.iosTitle': 'Install Nitidoc on your iPhone',
  'install.iosStep1': 'Tap the Share button in the Safari toolbar.',
  'install.iosStep2': 'Choose "Add to Home Screen" and confirm.',
  'install.iosHint': 'Nitidoc lands on your home screen like any other app — no App Store, no account.',

  'viewer.title': 'Document preview',
  'viewer.open': 'View document',
  'viewer.position': '{current} of {total}',
  'viewer.pageAlt': 'Page {n}',
  'viewer.previous': 'Previous page',
  'viewer.next': 'Next page',
  'viewer.renderError': 'This page could not be rendered.',

  'done.keep': 'Finish',
  'done.keepHint': 'Saved to your scans — you can open it again whenever you like.',

  'history.title': 'My scans',
  'history.open': 'Open history',
  'history.back': 'Back',
  'history.documentTitle': 'Scan {date}',
  'history.pageCount': { one: '{n} page', other: '{n} pages' },
  'history.openDocument': 'Open',
  'history.deleteDocument': 'Delete',
  'history.pin': 'Keep this scan',
  'history.unpin': 'Stop keeping this scan',
  'history.pinned': 'Kept',
  'history.empty': 'No saved scans yet',
  'history.emptyHint': 'Scans are saved here automatically when you tap "Done" after reviewing a document.',
  'history.loading': 'Loading your scans…',
  'history.usage': '{used} of {total} used',
  'history.saveError': 'Could not save this scan to your history.',
  'history.saveQuotaError': 'Not enough storage left to save this scan. Delete older scans and try again.',
  'history.openError': 'Could not open this scan.',
  'history.unavailable': 'Your browser has storage disabled, so scans cannot be saved.',
  'history.restoredNotice':
    'Restored from history — cropping now trims the already-straightened page instead of re-detecting the sheet.',
} satisfies Record<string, TranslationValue>;
