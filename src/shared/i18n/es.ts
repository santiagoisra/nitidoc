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
  'common.back': 'Volver',
  'common.close': 'Cerrar',
  'common.processing': 'Procesando…',
  'common.documentLimitReached': 'Se alcanzó el límite de documentos ({cap} páginas).',

  'lang.toggle': 'Cambiar idioma',

  'welcome.cta': 'Escanear documento',
  'welcome.openCamera': 'Abrir cámara',
  'welcome.hint': 'Al tocar se abre la cámara directamente',
  'welcome.sourceCode': 'Código abierto · AGPL-3.0',

  'scanner.openScanner': 'Abrir escáner',
  'scanner.cameraError': 'No se pudo abrir la cámara. Probá de nuevo o importá una imagen.',
  'scanner.loading': 'Cargando…',
  'scanner.scanComplete': { one: 'Escaneo completo — {n} página.', other: 'Escaneo completo — {n} páginas.' },
  'scanner.scanAnother': 'Escanear otro documento',
  'scanner.couldNotReadImage': 'No se pudo leer la imagen seleccionada.',
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

  'adjust.retake': 'Volver a tomar',
  'adjust.rotateLeft': 'Izquierda',
  'adjust.crop': 'Recortar',
  'adjust.next': 'Siguiente',
  'adjust.addMore': 'Agregar más',
  'adjust.prevPage': 'Página anterior',
  'adjust.nextPage': 'Página siguiente',
  'adjust.cropChip': 'Ajustar bordes',
  'adjust.cropDone': 'Listo',
  'adjust.cropCancel': 'Cancelar',

  'paper.format': 'Formato de papel',
  'paper.detected': 'Detectado: {format} ({confidence})',
  'paper.manual': 'Manual: {format}',
  'paper.clearToAuto': 'Usar formato detectado',
  'paper.confidenceHigh': 'confianza alta',
  'paper.confidenceMedium': 'confianza media',
  'paper.confidenceLow': 'confianza baja',
  'paper.confidenceNone': 'sin confianza suficiente',
  'paper.a4': 'A4',
  'paper.a4Probable': 'A4 probable',
  'paper.letter': 'Carta',
  'paper.legal': 'Legal',
  'paper.oficio': 'Oficio',
  'paper.ticket': 'Ticket',
  'paper.original': 'Original',

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
  'capture.captureDocument': 'Capturar documento',
  'capture.pageRemoved': 'Página eliminada.',
  'capture.undo': 'Deshacer',
  'capture.next': 'Siguiente',
  'capture.retakeLast': 'Repetir última captura',
  'capture.captureFailed': 'No se pudo capturar la página. Probá de nuevo.',
  'capture.importAnother': 'Importar otra',
  'capture.paperFormat': 'Tamaño de la hoja',
  'capture.paperGuide': 'Guía de encuadre para {format}',
  'capture.paperA4A3': 'A4 / A3',
  'capture.paperOficio': 'Oficio',
  'capture.paperLetter': 'Carta',
  'capture.paperLegal': 'Legal',
  'capture.paperTicket': 'Tarjeta / DNI',
  'capture.paperOriginal': 'Forma libre',

  'processing.title': 'Procesando tus páginas…',
  'processing.subtitle': 'Detectando bordes y corrigiendo perspectiva',
  'processing.progress': '{done} de {total}',
  'processing.failedPages': 'No se pudo procesar ninguna página. Probá de nuevo.',
  'processing.cancel': 'Cancelar',

  'grid.title': 'Documento',
  'grid.pageCount': { one: '{n} página', other: '{n} páginas' },
  'grid.reorderHint': 'Arrastrá el asa para reordenar',
  'grid.reorder': 'Reordenar página',
  'grid.pagesCaptured': { one: '{n} página capturada.', other: '{n} páginas capturadas.' },
  'grid.captureMore': 'Capturar más',
  'grid.finish': 'Listo',
  'grid.deletePage': 'Eliminar página',
  'grid.needsReview': 'Revisar',
  'grid.editPage': 'Editar página',
  'grid.emptyCta': 'Capturar',

  'done.title': '¡Documento listo!',
  'done.pagesScanned': { one: '{n} página escaneada', other: '{n} páginas escaneadas' },

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

  'camera.selectCamera': 'Seleccionar cámara',
  'camera.cameraN': 'Cámara {n}',

  'install.cta': 'Instalar app',
  'install.iosTitle': 'Instalá Nitidoc en tu iPhone',
  'install.iosStep1': 'Tocá el botón Compartir en la barra de Safari.',
  'install.iosStep2': 'Elegí "Agregar a inicio" y confirmá.',
  'install.iosHint': 'Nitidoc queda en tu pantalla de inicio como una app más — sin App Store, sin cuenta.',

  'viewer.title': 'Vista previa del documento',
  'viewer.open': 'Ver documento',
  'viewer.position': '{current} de {total}',
  'viewer.pageAlt': 'Página {n}',
  'viewer.previous': 'Página anterior',
  'viewer.next': 'Página siguiente',
  'viewer.renderError': 'No se pudo renderizar esta página.',

  'done.keep': 'Finalizar',
  'done.keepHint': 'Guardado en tus escaneos — podés abrirlo de nuevo cuando quieras.',

  'history.title': 'Mis escaneos',
  'history.open': 'Abrir historial',
  'history.back': 'Volver',
  'history.documentTitle': 'Escaneo {date}',
  'history.pageCount': { one: '{n} página', other: '{n} páginas' },
  'history.openDocument': 'Abrir',
  'history.deleteDocument': 'Eliminar',
  'history.pin': 'Conservar este escaneo',
  'history.unpin': 'Dejar de conservar este escaneo',
  'history.pinned': 'Conservado',
  'history.empty': 'Todavía no hay escaneos guardados',
  'history.emptyHint': 'Los escaneos se guardan acá solos cuando tocás "Listo" después de revisar un documento.',
  'history.loading': 'Cargando tus escaneos…',
  'history.usage': '{used} de {total} usados',
  'history.saveError': 'No se pudo guardar este escaneo en el historial.',
  'history.saveQuotaError':
    'No queda espacio suficiente para guardar este escaneo. Borrá escaneos viejos y probá de nuevo.',
  'history.openError': 'No se pudo abrir este escaneo.',
  'history.unavailable': 'Tu navegador tiene el almacenamiento desactivado, así que no se pueden guardar escaneos.',
  'history.restoredNotice':
    'Restaurado del historial: recortar ahora recorta la página ya enderezada, no vuelve a detectar la hoja.',
} satisfies Record<keyof typeof en, TranslationValue>;
