# Exploration — core-scanner (Fase 1: Core Scanner)

## Resumen ejecutivo

La Fase 1 requiere camara en vivo con deteccion de documento en tiempo real, auto-captura por estabilidad, correccion de perspectiva (deteccion de 4 esquinas + editor manual + warp), corriendo la deteccion/warp en un Web Worker segun el prompt maestro. El hallazgo tecnico mas importante: **`jscanify` retorna `HTMLCanvasElement` y depende del DOM, por lo que NO puede correr dentro de un Web Worker sin reimplementar su logica interna solo con `cv.Mat`** — esto es una contradiccion directa entre el stack elegido (seccion 2) y la regla de performance 2.1.2 del prompt maestro, y debe resolverse en `propose`. La recomendacion tecnica es usar OpenCV.js directo (reimplementando el algoritmo de jscanify: grayscale -> GaussianBlur -> Canny/threshold -> findContours -> approxPolyDP -> orden de esquinas) dentro del worker, en vez de la libreria jscanify tal cual. Los limites de iOS Safari (canvas > 16,777,216 px exactos) y las restricciones de COOP/COEP para WASM con threads son riesgos conocidos y acotables con decisiones de build simples (single-thread WASM, sin SIMD threads).

## Requisitos de Fase 1 extraidos del prompt

### F1 — Escaneo con camara en vivo (`nitidoc-prompt-maestro.md` seccion 3.1)
- Camara trasera por defecto: `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } } })`, con selector si hay varias camaras (linea 80).
- Overlay en tiempo real: contorno del documento en `--color-primary-light` (`#5EEAD4`), interpolando esquinas entre frames para evitar jitter (linea 81).
- Auto-captura: contorno estable (varianza de esquinas bajo umbral ~800ms) -> countdown visual de 3 puntos -> captura automatica; toggle para desactivar y usar el FAB manual (linea 82).
- Feedback de calidad: "Acercate mas", "Muy oscuro" (histograma), "Mantene firme" (blur por varianza laplaciana) (linea 83).
- Torch/flash si el dispositivo lo soporta: `ImageCapture` API / `applyConstraints({ advanced: [{ torch: true }] })` (linea 84).
- (Modo lote es F1 pero pertenece a Fase 2 segun el roadmap — fuera de alcance de esta exploracion, solo se documenta la superficie de API que lo dejaria enchufable despues.)

### F3 — Correccion de perspectiva (seccion 3.2)
- Deteccion automatica de 4 esquinas con jscanify: `findPaperContour` + `getCornerPoints` (linea 95).
- Editor manual de esquinas: 4 handles arrastrables + lupa magnificadora (zoom del area bajo el dedo, estilo apps nativas); validar cuadrilatero convexo (linea 96).
- Warp con `cv.warpPerspective` a un rectangulo con aspect ratio inferido (A4/carta/ticket por proporciones, con override manual) (linea 97).
- Rotacion 90 y volteo (linea 98) — mencionado en F3 pero es edicion post-warp simple; se incluye por completitud de scope de pagina, no como parte del pipeline de deteccion.

### Requisitos transversales relevantes (secciones 1.2, 2, 2.1, 5, 6, 7)
- **Diseno (1.2):** dark-first, `--color-bg #0F172A`, contorno de deteccion en `--color-primary-light #5EEAD4`, FAB de captura 72px con "anillo animado al detectar documento", `aria-live` para estados de deteccion, `prefers-reduced-motion`, targets tactiles >=44px.
- **Stack (2):** React 18 + TS + Vite, Zustand, Tailwind, **jscanify + OpenCV.js (WASM)** para deteccion/warp, Canvas API + WebGL para procesamiento (F4 esta fuera de esta fase, pero la infraestructura de canvas se comparte).
- **Performance (2.1):**
  1. OpenCV.js (~8MB WASM) NUNCA en el bundle inicial — lazy-load solo al entrar al modo escaner, con indicador de progreso, cacheado con Workbox `CacheFirst`.
  2. Deteccion de contornos y warp corren en **Web Worker** (`OffscreenCanvas` donde este disponible) — el hilo de UI nunca se bloquea.
  3. Deteccion en vivo a resolucion reducida (~640px de ancho); captura final del frame a resolucion completa.
  4. Bundle inicial < 200KB gzip (sin OpenCV lazy), TTI < 3s en 4G.
- **Arquitectura (5):** `src/features/scanner/{worker/opencv.worker.ts, hooks/useCamera.ts, hooks/useDocumentDetection.ts}`, `src/features/editor/` para esquinas/rotacion. Imagenes originales inmutables, ediciones como "receta" JSON aplicada al renderizar. Workers se comunican con transferables (`ImageBitmap`, `ArrayBuffer`) — nunca clonar imagenes grandes por `postMessage`. TS `strict: true`, sin `any`.
- **Casos borde (6) relevantes a esta fase:**
  - Permiso de camara denegado -> instrucciones por navegador + fallback a importar fotos.
  - Sin camara (desktop) -> default a import con drag & drop.
  - Documento no detectado en 5s -> hint "Apoya el documento sobre fondo liso y oscuro" + boton "Capturar igual" (recorte manual despues).
  - Contorno no convexo o esquina fuera de frame -> usar frame completo y abrir editor manual.
  - iOS Safari: canvas > 16MP falla -> cap de resolucion de captura, liberar `ImageBitmap.close()` agresivamente, revocar `ObjectURL`s.
  - OpenCV falla al cargar (red) -> reintento con backoff + modo degradado (recorte manual sin auto-deteccion).
  - Pantalla bloqueada/cambio de app durante escaneo -> pausar stream, restaurar con `visibilitychange`.
- **Seguridad (7):** HTTPS obligatorio (la camara no funciona sin HTTPS); CSP estricta, sin `unsafe-eval` salvo `'wasm-unsafe-eval'` para WASM; procesamiento 100% en dispositivo.

## Enfoque tecnico recomendado

### 1. Camara (`useCamera` hook)
- `getUserMedia` con constraints `facingMode: { ideal: 'environment' }` (usar `ideal` en vez de exacto para permitir fallback en desktop sin camara trasera) + `width/height: { ideal: ... }`. Nota: **no confirmado que `3840x2160` como `ideal` sea respetado por todos los dispositivos de gama media** — es una preferencia, el navegador puede devolver menor resolucion; el codigo debe leer `track.getSettings()` despues de abrir el stream para conocer la resolucion real.
- Selector de camara: enumerar con `navigator.mediaDevices.enumerateDevices()`, filtrar `kind === 'videoinput'`. Requiere haber pedido permiso una vez para que `label` no venga vacio.
- Torch: `track.getCapabilities()` para chequear si `torch` esta en la lista antes de llamar `track.applyConstraints({ advanced: [{ torch: true }] })`. **Gotcha confirmado:** el soporte de torch/zoom/pan/tilt es "device-gated" — iPhone y la mayoria de webcams de laptop NO exponen estas capacidades; hay que guardar el chequeo de capacidad y ocultar el boton de flash si no esta disponible, nunca asumir que existe.
- `ImageCapture` API tiene soporte solido en Chrome/Edge/Opera/Samsung Internet para Android, pero su soporte en Safari/iOS es historicamente parcial o inexistente — **no asumir disponibilidad; requiere feature-detection y fallback (capturar directamente del `<video>` a canvas via `drawImage`)**.
- `visibilitychange`: pausar el loop de deteccion cuando `document.hidden`, y re-solicitar/reanudar el stream al volver.

### 2. Deteccion + Worker (`opencv.worker.ts` + `useDocumentDetection`)
- Lazy-load de OpenCV.js WASM SOLO al entrar al modo escaner: `import()` dinamico o carga via `WebAssembly.instantiateStreaming` segun el build. Cachear con Workbox `CacheFirst` (regla 2.1.1).
- **Punto critico confirmado:** `jscanify` expone `findPaperContour(mat)` y `getCornerPoints(contour)` que SI operan sobre `cv.Mat` (DOM-free), pero otros metodos (`extractPaper`, `highlightPaper`) devuelven `HTMLCanvasElement` y requieren DOM. Para correr 100% dentro de un worker hay dos caminos:
  a. Usar SOLO las funciones DOM-free de jscanify — SI el modulo no referencia `document` en su top-level (a verificar leyendo el fuente).
  b. Reimplementar el pipeline con OpenCV.js puro: `cv.matFromImageData` -> `cv.cvtColor` a gris -> `cv.GaussianBlur` -> `cv.Canny`/threshold adaptativo -> `cv.findContours` -> `cv.approxPolyDP` (poligono de 4 lados de mayor area) -> orden de esquinas (top-left = min(x+y), bottom-right = max(x+y), top-right = min(y-x), bottom-left = max(y-x)) -> `cv.getPerspectiveTransform` + `cv.warpPerspective`. 100% DOM-free; enfoque mas seguro para worker.
- Transferencia de datos: `createImageBitmap(video)` en el hilo principal, enviar el `ImageBitmap` al worker con `transfer: [bitmap]` (zero-copy), reconstruir dibujandolo en un `OffscreenCanvas` interno + `getImageData` + `cv.matFromImageData`. **No hay conversion directa `ImageBitmap`->`cv.Mat` sin canvas intermedio.**
- Resolucion reducida para deteccion en vivo (~640px ancho) segun regla 2.1.3; captura final del frame full-res.
- COOP/COEP: **usar el build single-thread de OpenCV.js sin SIMD-threads para Fase 1**. Hay bug conocido (OpenCV GitHub #25790, #25956; foro oficial) donde OpenCV.js con WASM threads falla en un Web Worker, ademas de requerir `SharedArrayBuffer` (gateado por COOP/COEP). El prompt ya sugiere esta salida. SIMD sin threads es mejora segura a evaluar despues.

### 3. Warp / correccion de perspectiva
- `cv.getPerspectiveTransform(srcCorners, dstCorners)` + `cv.warpPerspective(src, dst, M, new cv.Size(outW, outH))`.
- Inferencia de aspect ratio: ancho/alto del cuadrilatero (promedio de lados opuestos), comparar contra ratios conocidos (A4 ~1:1.414, carta ~1:1.294, ticket angosto) con tolerancia; override manual en la UI.
- Salida del warp: alternativa segura y confirmada a `cv.imshow` (no confirmado que acepte `OffscreenCanvas` en todas las builds): extraer `mat.data` -> `ImageData` -> `OffscreenCanvas.putImageData` -> transferir como `ImageBitmap` de vuelta.

### 4. Editor manual de esquinas
- 4 handles arrastrables sobre canvas/SVG overlay sobre la imagen capturada (no sobre el video en vivo).
- Lupa magnificadora: recorte ampliado (2x-3x) de la zona bajo el dedo en un canvas circular flotante, via `drawImage`.
- Validacion de convexidad: producto cruzado consecutivo de los 4 vertices sin cambio de signo, antes de habilitar confirmar/warp.
- Actualizar el warp al soltar un handle (no en cada frame de arrastre) — enviar solo las 4 coordenadas finales al worker.

### 5. Feedback de calidad
- Blur: varianza del Laplaciano (`cv.Laplacian` + varianza). Umbral ~200 para 300 DPI; para camara en vivo a 640px sera menor (~100 de partida) — **calibrar empiricamente en Fase 1**.
- Iluminacion: histograma de intensidad en gris; media muy baja (oscuro) o saturacion alta -> warning. Correr sobre el frame reducido (640px).
- Ambos calculos pueden correr en el mismo worker, reusando el `cv.Mat` en gris ya calculado para contornos.

## Forks de decision con tradeoffs

| Fork | Opcion A | Opcion B | Recomendacion |
|---|---|---|---|
| **jscanify vs OpenCV.js directo** | jscanify tal cual | Reimplementar pipeline con OpenCV.js puro en worker | **B** — jscanify depende del DOM en varios metodos; no se garantiza import limpio en Worker sin `document`. Reimplementar el algoritmo cumple la regla 2.1.2 al pie. jscanify queda como referencia de fallback en hilo principal, no como dependencia del worker. |
| **OffscreenCanvas+worker vs canvas en hilo principal para warp** | Todo en worker con `OffscreenCanvas` | Deteccion en worker, warp en hilo principal | **A** — el prompt exige explicitamente warp en Worker. Fallback B solo si `OffscreenCanvas` no disponible (Safari <16.4): streaming de `ImageBitmap`/`ImageData` sin `OffscreenCanvas`. |
| **OpenCV.js single-thread vs multi-thread** | Single-thread, sin SIMD-threads | Threads+SIMD, requiere COOP/COEP + SharedArrayBuffer | **A** — bug confirmado de threads+worker (#25790, #25956); evita configurar COOP/COEP en Firebase Hosting (que puede romper OAuth popup de Firebase Auth). El prompt ya sugiere single-thread. |
| **Auto-captura: countdown vs inmediata** | Countdown de 3 puntos tras estabilidad | Captura inmediata | Requisito explicito del prompt (countdown). No es fork real; el countdown agrega ~800ms-1s de espera percibida a balancear en UX. |
| **Torch/capacidades: feature-detect vs asumir** | `getCapabilities()` antes de `applyConstraints` | Intentar y capturar excepcion | **A** — torch es device-gated; chequear capacidades permite ocultar el boton de flash cuando no aplica. |

## Casos borde de Fase 1

- Canvas > 16,777,216 px (16MP, iOS Safari) falla -> cap explicito de resolucion de captura antes de crear cualquier canvas/OffscreenCanvas (hilo principal y worker).
- Liberar `ImageBitmap.close()` y `URL.revokeObjectURL()` agresivamente tras cada captura — critico en iOS por presion de memoria.
- No detectado en 5s -> hint + boton "Capturar igual" -> editor manual con frame completo (4 esquinas por defecto en las esquinas del frame).
- Contorno no convexo o esquina fuera de frame -> mismo fallback (frame completo + editor manual).
- Sin camara en desktop -> detectar ausencia de `videoinput` o fallo de `getUserMedia` y ofrecer importar imagen (superficie minima de "elegir imagen" necesaria para el criterio "funciona en desktop").
- OpenCV falla al cargar (fetch WASM) -> reintento con backoff + modo degradado (frame completo + editor manual obligatorio).
- `visibilitychange` -> pausar loop (`requestVideoFrameCallback`/`rAF`) y `track` de video en segundo plano; restaurar al volver.

## Riesgos e incognitas para propose

1. **jscanify en worker (riesgo alto, parcialmente confirmado):** no confirmado si el fuente de jscanify referencia `document`/`window` en el top-level del modulo (rompería el import aunque no se llame la funcion problematica). `propose` debe decidir: (a) leer el fuente de jscanify, o (b) ir directo a reimplementacion con OpenCV.js puro.
2. **COOP/COEP y Firebase Auth (riesgo medio, diferido):** `COOP: same-origin` por SIMD-threads puede interferir con OAuth popup de Firebase Auth en Fase 5. Fase 1 single-thread lo difiere; anotar para Fase 5.
3. **Umbral de varianza laplaciana (incognita, calibracion empirica):** sin valor universal para camara movil a 640px; requiere pruebas con dispositivos reales antes de fijar en `design`/`tasks`.
4. **`cv.imshow` con `OffscreenCanvas` (incognita tecnica):** no confirmado el soporte; usar extraccion `mat.data` -> `ImageData` como camino seguro. Impacta el contrato de mensajes worker<->hilo principal.
5. **Soporte real de `ImageCapture`/torch en iOS Safari (riesgo medio-alto):** incierto/parcial en Safari/iOS pese a ser el navegador prioritario de testing. Comunicar como limitacion conocida, no bug.
6. **Resolucion "ideal" 3840x2160 vs hardware real:** en gama media/baja se negocia menor; coexistir con el cap de 16MP de iOS sin asumir 4K.
7. **Tamano del build de OpenCV.js:** el subconjunto real (contornos + perspectiva + Laplacian) es chico; `propose`/`design` deberian evaluar un build custom recortado en vez del generico completo para reducir el peso lazy.

## Preguntas abiertas

1. Decidir en `propose` si Fase 1 usa jscanify como dependencia real o solo como referencia de algoritmo (reimplementado con OpenCV.js puro). Determina si `package.json` lista `jscanify`.
2. Que build de OpenCV.js (prebuilt oficial vs custom con Emscripten) — impacta peso y disponibilidad de `cv.imshow` sobre `OffscreenCanvas`.
3. Umbral de estabilidad de esquinas (~800ms) y umbral laplaciano de blur -> calibrar con pruebas reales antes de `tasks`; por ahora valores de partida.

## Ready for Proposal

Si — hay suficiente informacion tecnica y hallazgos concretos (incompatibilidad jscanify/worker; bug de OpenCV.js con threads en worker) para que `sdd-propose` tome decisiones de arquitectura informadas. El unico bloqueo real es el fork jscanify-vs-OpenCV.js-puro, planteado explicitamente con recomendacion clara.
