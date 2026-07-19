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
  'common.close': 'Close',
  'common.processing': 'Processing…',
  'common.documentLimitReached': 'Document limit reached ({cap} pages).',

  'lang.toggle': 'Switch language',

  'welcome.cta': 'Scan document',
  'welcome.hint': 'Tapping opens the camera directly',

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
  'grid.reorderHint': 'Press and hold a page to reorder',
  'grid.pagesCaptured': { one: '{n} page captured.', other: '{n} pages captured.' },
  'grid.captureMore': 'Capture more',
  'grid.finish': 'Finish',
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
} satisfies Record<string, TranslationValue>;
