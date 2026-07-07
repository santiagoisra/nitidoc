# Exploration: multipage-filters (Fase 2 — Gestion multipagina + Filtros)

> Retrieved verbatim from Engram (`sdd/multipage-filters/explore`, obs #304). The explore
> sub-agent had no filesystem Write tool, so this file reconstructs the exploration on disk to
> satisfy the openspec convention.

### Current State

Modelo de datos hoy (single-page, F1 ya implementada y en main):
- `ScannerStore` (src/features/scanner/store/scannerStore.ts) tiene 4 slices: CameraSlice, DetectionSlice, CaptureSlice, OpenCvSlice. CaptureSlice guarda UNA sola pagina: `{ originalFrame: CapturedFrame | null, warpedImage: ImageBitmap | null, recipe: EditRecipe | null, phase }`.
- `EditRecipe` (src/shared/types/scanner.ts) es JSON puro sin filtros: `{ corners, aspectRatio, rotation, flipH, flipV }`.
- ScannerScreen.tsx: camara viva -> runCaptureSequence -> CornerEditor (warp via worker) -> handleEditorConfirm marca phase:'done'. NO hay bandeja/lista de paginas; resetCaptureSlice() cierra bitmaps y vuelve a idle; "Scan another document" reinicia todo perdiendo la pagina anterior.
- Worker (opencv.worker.ts) singleton por sesion, RPC por id, 3 tipos: INIT, DETECT/DETECT_IMAGEDATA, WARP. Higiene de memoria estricta (close-before-overwrite, cap 16MP, un solo OffscreenCanvas reusado). Sin mensajes de filtro todavia.
- Sin dnd-kit, sin WebGL, sin libreria de filtros en package.json.

### Modelo propuesto

```ts
export interface FilterParams {
  readonly preset: 'original'|'enhanced'|'grayscale'|'bw'|'bw-high-contrast'|'eco';
  readonly brightness: number; // -100..100
  readonly contrast: number;   // -100..100
  readonly sharpness: number;  // 0..100
}
export interface EditRecipe {
  readonly corners: Quad;
  readonly aspectRatio: AspectRatioName;
  readonly rotation: 0|90|180|270;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly filter: FilterParams; // NUEVO
}
export interface DocumentPage {
  readonly id: string;
  readonly originalFrame: CapturedFrame;
  readonly warpedImage: ImageBitmap | null; // cacheado SIN filtro aplicado
  readonly recipe: EditRecipe;
  readonly order: number;
}
export interface DocumentSlice {
  readonly pages: readonly DocumentPage[];
  readonly activePageId: string | null;
  readonly selectedPageIds: readonly string[];
  readonly phase: 'idle'|'capturing'|'editing-corners'|'warping'|'tray'|'grid'|'done';
}
```

Decision clave: warpedImage se cachea SIN filtro (filtro = capa de presentacion sobre warpedImage, igual patron que rotation/flip hoy vía ADR-005 de F1). Evita re-invocar OpenCV por cada cambio de slider.

Migracion: CaptureSlice se RETIRA y reemplaza por DocumentSlice (migracion directa, no wrapper de compatibilidad) — ScannerScreen/CornerEditor deben reescribirse para leer/escribir la pagina activa. Tratar como su propio primer grupo de tareas en sdd-tasks; tests de F1 (CornerEditor, ScannerScreen) deben reescribirse contra la nueva forma.

### Enfoque tecnico por subsistema

(a) Los 6 filtros:
- Original/Color realzado/Escala de grises: viables como shaders WebGL (per-pixel o 2-pass gaussian blur separable para unsharp mask; white-balance gray-world requiere un promedio global precomputado como uniform, no per-pixel puro).
- B&N/Alto contraste B&N/Eco: dependen de adaptive threshold (vecindad local) + morfologia (erode/dilate) — NO trivial en fragment shader simple. RECOMENDACION: reusar el worker OpenCV ya existente (cv.adaptiveThreshold, cv.morphologyEx/erode/dilate, mismo modulo imgproc que ya usa DETECT). Verificacion empirica pendiente: confirmar que el binding de @techstark/opencv-js expone estas funciones (cvBindings.ts hoy solo tipa lo que F1 usa).
- Preview de thumbnail: 6 previews sobre un thumbnail chico (~150x200px) es barato; los 3 filtros OpenCV pueden batchearse en un mensaje nuevo al worker (ej. APPLY_ADAPTIVE_FILTER) para evitar 3 roundtrips.
- Fallback Canvas2D+filter: cubre grayscale/saturate/contrast pero NO adaptive threshold — B&N y variantes siempre dependen del worker con o sin WebGL.

(b) Modo lote/bandeja: tras cada WARP_RESULT confirmado, la pagina se agrega a pages[] y la camara permanece abierta (reusar el mismo patron que hoy usa handleEditorCancel para retomar startDetection). Thumbnails de bandeja deben generarse UNA vez (createImageBitmap con resizeWidth chico) y cachearse aparte del warpedImage full-res — no re-renderizar el full-res en cada frame de la bandeja.

(c) Grilla/reorden: nueva dependencia @dnd-kit/core + @dnd-kit/sortable (no existe hoy). Al onDragEnd, recalcular order de TODO el array (no update parcial) para evitar huecos/duplicados. Undo por toast 5s: no hay libreria de toast; construir uno en shared/ui + un buffer pendingDeletion en el store que retiene el DocumentPage completo (bitmaps sin cerrar) durante la ventana de undo.

### Forks de decision + recomendacion

1. Filtro embebido en EditRecipe (A) vs slice separado Record<pageId,FilterParams> (B) -> RECOMENDADO A (mantiene "receta = JSON puro reconstruye todo", patron de F1).
2. B&N/variantes: shader GLSL propio (A) vs reusar worker OpenCV (B) -> RECOMENDADO B (worker ya caliente, imgproc ya cargado, menor riesgo que reimplementar adaptive threshold+morfologia en GLSL).
3. Migracion store: directa (A) vs wrapper de compatibilidad (B) -> RECOMENDADO A (F1 ya en main, wrapper agrega indireccion permanente sin beneficio).
4. warpedImage cacheado sin filtro (A) vs con filtro horneado (B) -> RECOMENDADO A (consistente con ADR-005, filtro se aplica en presentacion).
5. Thumbnails al vuelo (A) vs cacheados al confirmar pagina (B) -> RECOMENDADO B (evita recompute en cada render de grilla).

### Riesgos e incognitas para propose

1. [ALTO] Presupuesto de memoria multipagina en iOS: 5+ paginas full-res (~48MB c/u a 12MP) puede acercarse a 240MB solo de originales — decision de producto pendiente: ¿liberar originalFrame tras confirmar warp (pierde re-warp) o retenerlo todo (riesgo de memoria)?
2. [INCOGNITA] Confirmar binding real de adaptiveThreshold/morphologyEx en @techstark/opencv-js ^4.10.0 antes de comprometerse en design.
3. [MEDIO] Costo real de unsharp mask/white-balance en shader no prototipado aun.
4. [MEDIO] Migracion de store es cambio no-aditivo que rompe tests existentes de F1 — presupuestar como grupo de tareas propio.
5. [INCOGNITA] Semantica exacta de "filtro por pagina o a todo el documento" (sobrescribe individuales o es solo atajo de UI) — clarificar en propose/spec.
6. [BAJO] dnd-kit es nueva dependencia — verificar impacto de bundle (lazy-load del feature de grilla recomendado).

### Preguntas abiertas
1. Limite duro de paginas por documento en F2, o ilimitado con liberacion agresiva de originalFrame?
2. Si se libera originalFrame tras confirmar, ¿el editor de esquinas re-edita sobre warpedImage ya recortado como fallback aceptado?
3. "Aplicar filtro a todo el documento": ¿batch en una sola llamada al worker o de a una pagina?

### Ready for Proposal
Yes — con las 2 incognitas marcadas (binding OpenCV real, limite de memoria iOS) como primeras preguntas a resolver en sdd-propose antes de comprometer arquitectura final.
