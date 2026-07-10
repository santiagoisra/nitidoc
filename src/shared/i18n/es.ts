import { en } from '@/shared/i18n/en';
import type { TranslationValue } from '@/shared/i18n/types';

/**
 * Spanish dictionary — the app's REAL default locale (see `LocaleProvider`).
 * `satisfies Record<keyof typeof en, TranslationValue>` makes a missing key
 * a COMPILE error: every key `en` defines must exist here too.
 *
 * Tone: rioplatense-neutral, professional (voseo in instructional copy —
 * "ajustá", "capturá" — matches the app's conversational-but-precise register
 * without leaning on slang). Proper/technical terms kept as-is (PDF, A4,
 * Eco) per the i18n pass's own scope note.
 */
export const es = {
  'common.close': 'Cerrar',
  'common.processing': 'Procesando…',
  'common.documentLimitReached': 'Se alcanzó el límite de documentos ({cap} páginas).',

  'lang.toggle': 'Cambiar idioma',

  'scanner.openScanner': 'Abrir escáner',
  'scanner.cameraError': 'No se pudo abrir la cámara. Probá de nuevo o importá una imagen.',
  'scanner.loading': 'Cargando…',
  'scanner.scanComplete': { one: 'Escaneo completo — {n} página.', other: 'Escaneo completo — {n} páginas.' },
  'scanner.scanAnother': 'Escanear otro documento',
  'scanner.noDocumentDetected': 'Todavía no se detectó ningún documento.',
  'scanner.captureAnyway': 'Capturar de todos modos',
  'scanner.couldNotReadImage': 'No se pudo leer la imagen seleccionada.',
  'scanner.autoOn': 'Auto activado',
  'scanner.autoOff': 'Auto desactivado',
  'scanner.toggleTorch': 'Alternar linterna',
  'scanner.exportPdf': 'Exportar PDF',
  'scanner.exporting': 'Exportando…',
  'scanner.exportPdfError': 'No se pudo exportar el PDF.',

  'editor.cornerHandle': 'Manija de esquina {n}',
  'editor.convexWarning': 'Las esquinas deben formar una figura convexa. Ajustá una manija para continuar.',
  'editor.rotate': 'Rotar 90 grados',
  'editor.flipHorizontal': 'Voltear horizontalmente',
  'editor.processError': 'No se pudo procesar la imagen. Ajustá una esquina para reintentar.',
  'editor.back': 'Atrás',
  'editor.next': 'Siguiente',
  'editor.confirm': 'Confirmar',
  'editor.aspectA4': 'A4',
  'editor.aspectLetter': 'Carta',
  'editor.aspectTicket': 'Ticket',
  'editor.aspectOriginal': 'Original',

  'filter.title': 'Filtros',
  'filter.presetOriginal': 'Original',
  'filter.presetEnhanced': 'Mejorado',
  'filter.presetGrayscale': 'Escala de grises',
  'filter.presetBw': 'B/N',
  'filter.presetBwHighContrast': 'B/N alto contraste',
  'filter.presetEco': 'Eco',
  'filter.brightness': 'Brillo',
  'filter.contrast': 'Contraste',
  'filter.sharpness': 'Nitidez',
  'filter.applyToAll': 'Aplicar a todas las páginas',
  'filter.applyToAllConfirmText':
    '¿Aplicar este filtro a todas las páginas? Se sobrescribirán los filtros individuales.',
  'filter.cancel': 'Cancelar',
  'filter.applyToAllConfirmButton': 'Aplicar a todas',

  'capture.pagesCaptured': { one: '{n} página capturada', other: '{n} páginas capturadas' },
  'capture.done': 'Listo',
  'capture.autoCapturingIn': 'Captura automática en {n}',
  'capture.captureDocument': 'Capturar documento',
  'capture.pageRemoved': 'Página eliminada.',
  'capture.undo': 'Deshacer',
  'capture.next': 'Siguiente',
  'capture.retakeLast': 'Repetir última captura',
  'capture.captureFailed': 'No se pudo capturar la página. Probá de nuevo.',
  'capture.importAnother': 'Importar otra',

  'grid.pagesCaptured': { one: '{n} página capturada.', other: '{n} páginas capturadas.' },
  'grid.captureMore': 'Capturar más',
  'grid.finish': 'Finalizar',
  'grid.deletePage': 'Eliminar página',

  'import.instructionsFirefox':
    'Abrí el ícono de candado en la barra de direcciones, poné la Cámara en "Permitir" y volvé a cargar la página.',
  'import.instructionsLockIcon':
    'Hacé clic en el ícono de candado/información en la barra de direcciones, poné la Cámara en "Permitir" y volvé a cargar la página.',
  'import.instructionsSafari':
    'Abrí Configuración de Safari > Sitios web > Cámara, permití este sitio y volvé a cargar la página.',
  'import.cameraAccessDenied': 'Se denegó el acceso a la cámara.',
  'import.noCameraDetected':
    'No se detectó ninguna cámara en este dispositivo. Igual podés escanear un documento importando un archivo de imagen.',
  'import.importImage': 'Importar imagen',
  'import.importADocumentImage': 'Importar una imagen de documento',
  'import.processingStatus': 'Procesando la imagen seleccionada, esperá por favor.',

  'opencv.unavailable':
    'La detección de documentos no está disponible en este momento{error}. Igual podés capturar una foto y ajustar sus esquinas manualmente.',
  'opencv.retry': 'Reintentar',

  'quality.moveCloser': 'Acercate más',
  'quality.tooDark': 'Muy oscuro',
  'quality.blurry': 'Imagen borrosa — enfocá',
  'quality.detecting': 'Detectando… mantené firme',

  'camera.selectCamera': 'Seleccionar cámara',
  'camera.cameraN': 'Cámara {n}',
} satisfies Record<keyof typeof en, TranslationValue>;
