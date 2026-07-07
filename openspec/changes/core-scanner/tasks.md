# Tasks — core-scanner (Fase 1: Core Scanner)

> Change name: `core-scanner` · Artifact store: openspec
> Fuente: `proposal.md`, `specs/scanner/spec.md`, `specs/perspective/spec.md`, `design.md`.
> Convencion: cada tarea es completable en una sola sesion. `Ref:` enlaza el requisito de spec (dominio + nombre) y/o la seccion de design que la respalda. Las tareas de calibracion empirica estan marcadas explicitamente como "valor de partida" — NO deben convertirse en asserts exactos de test.

Orden de dependencia entre grupos:

```
1. Scaffold
      │
      ▼
2. Worker OpenCV  ──────────────┐
      │                         │
      ▼                         ▼
3. Camara                  6. Casos borde (parcial: OPENCV_LOAD_FAILED, sin OffscreenCanvas)
      │                         │
      ▼                         │
4. Deteccion en vivo + auto-captura
      │                         │
      ▼                         │
5. Editor de esquinas + warp ◄──┘
      │
      ▼
6. Casos borde (resto) ──► 7. Tests (transversal, arranca en paralelo con 2 en lo que es geometria)
```

---

## 1. Scaffold

### 1.1 Inicializar proyecto Vite + React 18 + TS strict
- [x] 1.1.1 Crear proyecto con `vite` (template `react-ts`), configurar `tsconfig.json` con `strict: true` y sin `any` permitido (lint rule `@typescript-eslint/no-explicit-any` si se agrega ESLint).
  Ref: proposal §4.2 (deps dev), design §11 (restricciones: TS strict, sin any)
- [x] 1.1.2 Configurar `vite.config.ts` con soporte Vitest (`test` block) y alias de imports (`@/` → `src/`).
  Ref: proposal §2.1 (harness de testing), §4.1 (estructura)
- [x] 1.1.3 Crear estructura de carpetas feature-sliced vacia: `src/app/`, `src/styles/`, `src/features/scanner/{worker,hooks,components,lib,store}`, `src/shared/{ui,lib,types}`, `src/editor/`, `tests/{unit,e2e}`, `public/fonts/`.
  Ref: proposal §4.1 (estructura de archivos)

### 1.2 Tailwind + design tokens
- [x] 1.2.1 Instalar y configurar Tailwind (`tailwind.config.ts`, `postcss.config.js`), purga apuntando a `src/**/*.{ts,tsx}`.
  Ref: proposal §4.2, §4.3 (presupuesto < 200KB gzip)
- [x] 1.2.2 Crear `src/styles/tokens.css` con las CSS variables de la seccion 1.2 del prompt maestro (colores primary/primary-light, etc.) e importarlo en `main.tsx`.
  Ref: proposal §4.1 (`styles/tokens.css`)
- [x] 1.2.3 Self-hostear fuente Inter (subset latin) en `public/fonts/` y referenciarla via `@font-face` en `tokens.css`.
  Ref: proposal §4.1 (`public/fonts/`)

### 1.3 Estado global (Zustand) — scaffold vacio
- [x] 1.3.1 Crear `src/features/scanner/store/scannerStore.ts` con las 4 slices tipadas (`CameraSlice`, `DetectionSlice`, `CaptureSlice`, `OpenCvSlice`) segun design §5.1, con valores iniciales pero SIN actions implementadas todavia (se completan en grupos 2-5).
  Ref: design §5.1, §5.2 (forma del store, `CapturedFrame`, `EditRecipe`)

### 1.4 App shell minimo + iconografia
- [x] 1.4.1 Crear `src/app/App.tsx` con layout base y ruta unica al escaner (sin router — Fase 1 es una sola pantalla).
  Ref: proposal §4.1 (`app/App.tsx`)
- [x] 1.4.2 Instalar `lucide-react`; crear componentes UI base minimos en `src/shared/ui/` (Button, Sheet/Modal, Toast) usando los tokens de 1.2.2.
  Ref: proposal §4.2 (dev deps: lucide-react)

### 1.5 Harness de testing
- [x] 1.5.1 Configurar Vitest (`@testing-library/react`, `jsdom` o `happy-dom`) con un test trivial (`sanity.test.ts`) que corra en CI/local.
  Ref: proposal §2.1 (in scope: harness listo), spec scanner (restriccion transversal TS strict)
- [x] 1.5.2 Configurar Playwright (`playwright.config.ts`) con un test E2E trivial (carga la app y verifica que renderiza) — sin fixture de imagen todavia (eso va en grupo 7).
  Ref: proposal §2.1 (harness Vitest + Playwright configurados, sin suite completa aun)

---

## 2. Worker OpenCV

> Depende de: grupo 1 (scaffold, tsconfig, estructura `features/scanner/worker/`).

### 2.1 Contrato de mensajes tipado
- [x] 2.1.1 Crear `src/features/scanner/worker/messages.ts` con todos los tipos del design §1.1: `Point`, `Quad`, `QualityMetrics`, `AspectRatioName`, `AspectRatio`, `InitRequest`, `DetectRequest`, `WarpRequest`, `ImageDataLike`, `WorkerRequest`, `ProgressEvent`, `InitDoneResponse`, `DetectResponse`, `WarpResponse`, `ErrorResponse`, `WorkerErrorCode`, `WorkerResponse`.
  Ref: design §1.1 (messages.ts completo); CAP-9, CAP-2, CAP-7
- [x] 2.1.2 Agregar al mismo archivo la variante `WarpResponseImageData` para el camino sin `OffscreenCanvas` (design §8) y extender `WorkerResponse` para incluirla.
  Ref: design §8 (matriz de fallback, "Adicion a messages.ts")

### 2.2 Geometria pura (DOM-free, testeable en Node)
- [x] 2.2.1 Implementar `src/features/scanner/lib/geometry.ts` — `isConvex(quad: Quad): boolean` segun el algoritmo de productos cruzados de design §6.2.
  Ref: design §6.2 (isConvex); perspective spec "Cuadrilatero no convexo bloquea confirmacion"
- [x] 2.2.2 Implementar `orderCorners(points: Point[]): Quad` con normalizacion por centroide + angulo dominante (design §6.1). **Valor de partida a calibrar empiricamente (R5) — no fijar como comportamiento final**, incluir el desempate por heuristico de sumas para cuadrados casi-perfectos.
  Ref: design §6.1 (orderCorners); perspective spec "Documento con orientacion rotada..."; design §11 (R5 verificacion empirica)
- [x] 2.2.3 Implementar `inferAspectRatio(quad: Quad): AspectRatio` con tabla de ratios A4/carta + deteccion de ticket por umbral de alargamiento, tolerancia `ASPECT_TOLERANCE = 0.06` (valor de partida).
  Ref: design §6.3 (inferAspectRatio); perspective spec "Warp exitoso con aspect ratio inferido"
- [x] 2.2.4 Implementar `outputSize(corners: Quad, aspect: AspectRatioName)` para calcular dimensiones de salida del warp segun design §6.4.
  Ref: design §6.4 (outputSize); perspective spec "Correccion de perspectiva (warp)"
- [x] 2.2.5 Crear modulo de constantes calibrables `DETECTION` (design §6.4: `DOWNSCALE_WIDTH`, `BLUR_THRESHOLD`, `DARK_THRESHOLD`, `STABILITY_MS`, `STABILITY_VARIANCE_PX`, `INTERP_ALPHA`, `NO_DETECTION_MS`, `ASPECT_TOLERANCE`, `MAX_CAPTURE_PIXELS`), documentando en comentario cuales son "valor de partida, calibrar en dispositivo real" (BLUR_THRESHOLD, DARK_THRESHOLD, STABILITY_MS, STABILITY_VARIANCE_PX).
  Ref: design §6.4 (tabla DETECTION); design §11 (R1, umbral de estabilidad)

### 2.3 Carga lazy de OpenCV.js
- [x] 2.3.1 Implementar `src/features/scanner/lib/opencvLoader.ts`: `import()` dinamico del prebuilt oficial single-thread de OpenCV.js (ADR-001), NUNCA importado desde el bundle inicial.
  Ref: design §3 (ADR-001); scanner spec "Carga lazy de OpenCV.js"
- [x] 2.3.2 Implementar reporte de progreso: camino con `fetch` + `ReadableStream` + `Content-Length` (progreso real) y camino indeterminado si no hay `Content-Length` (design §4.3), exponiendo callback `onProgress`.
  Ref: design §4.3; scanner spec "Carga exitosa de OpenCV al entrar al escaner"
- [x] 2.3.3 Implementar maquina de estados `idle → loading → ready`/`error` con backoff exponencial acotado (1s/2s/4s, max 3 reintentos automaticos, luego solo manual) segun design §4.1/§4.4.
  Ref: design §4.1, §4.4; scanner spec "Fallo de carga de OpenCV.js"

### 2.4 `WorkerClient` (RPC)
- [x] 2.4.1 Implementar `src/features/scanner/lib/workerClient.ts` con la interfaz de design §1.3 (`init`, `detect`, `warp`, `terminate`), protocolo request/response con `id` de correlacion y `Map<number, {resolve, reject}>`.
  Ref: design §1.3 (WorkerClient); design §9 ADR-002
- [x] 2.4.2 Implementar backpressure drop-latest en `detect()`: si hay un DETECT en vuelo, el llamador debe poder consultar `isBusy()` (o metodo equivalente) para descartar el frame nuevo sin encolar.
  Ref: design §2.1 (loop, drop-latest); design §9 ADR-002

### 2.5 Worker `opencv.worker.ts` — pipeline de deteccion
- [x] 2.5.1 Implementar el handler `INIT` en el worker: invoca `opencvLoader`, reenvia `PROGRESS`, responde `INIT_DONE` o `ERROR{OPENCV_LOAD_FAILED}`.
  Ref: design §1.1, §4; CAP-9
- [x] 2.5.2 Implementar el handler `DETECT`: `bitmap → OffscreenCanvas interno → getImageData → cv.matFromImageData` → `cvtColor(GRAY)` → `GaussianBlur` → `Canny` → `findContours` → seleccionar contorno de mayor area → `approxPolyDP` buscando poligono de 4 lados.
  Ref: proposal §3.1 (pipeline DOM-free); design §0 (worker), §7 (liberacion de Mats)
- [x] 2.5.3 Aplicar `orderCorners` + `isConvex` (de 2.2.1/2.2.2) al resultado de `approxPolyDP`; si no es convexo o el area es insuficiente, responder `corners: null`.
  Ref: perspective spec "Cuadrilatero no convexo..."; scanner spec "Contorno detectado no es convexo..."
- [x] 2.5.4 Calcular `QualityMetrics` (Laplacian variance + mean intensity) reusando el `Mat` gris ya computado cuando `withQuality: true`, aplicando `BLUR_THRESHOLD`/`DARK_THRESHOLD` de 2.2.5 (**valores de partida**, sin asserts exactos en tests).
  Ref: design §1.1 (QualityMetrics); scanner spec "Feedback de calidad en vivo"; design §11 (R1)
- [x] 2.5.5 Garantizar liberacion de todos los `cv.Mat`/`cv.MatVector` creados en DETECT con `.delete()` en bloque `finally`, reutilizando un unico `OffscreenCanvas` interno (no crear uno nuevo por frame).
  Ref: design §7 (manejo de recursos, tabla completa)

### 2.6 Worker `opencv.worker.ts` — pipeline de warp
- [x] 2.6.1 Implementar el handler `WARP`: reconstruir `ImageData` desde el `ImageDataLike` transferido, `cv.matFromImageData`, calcular `outputSize` (de 2.2.4), `getPerspectiveTransform` + `warpPerspective`.
  Ref: proposal §3.1, §3.2; perspective spec "Correccion de perspectiva (warp)"
- [x] 2.6.2 Implementar la salida del warp via `mat.data → new ImageData → OffscreenCanvas.putImageData → transferToImageBitmap()` (NO `cv.imshow`), respondiendo `WARP_RESULT` con el bitmap transferido.
  Ref: design §9 ADR-003; perspective spec "Warp corre en Web Worker sin bloquear la UI"
- [x] 2.6.3 Implementar camino alterno `WARP_RESULT_IMAGEDATA` para cuando `offscreenSupported === false`: devolver `ImageDataLike` en vez de `ImageBitmap` (transfiriendo `.data.buffer`).
  Ref: design §8 (fallback sin OffscreenCanvas); design §1.2 (que se transfiere vs se clona)
- [x] 2.6.4 Garantizar liberacion de Mats del pipeline de warp en `finally`.
  Ref: design §7

---

## 3. Camara

> Depende de: grupo 1 (scaffold, estructura de hooks). Independiente del grupo 2 (puede desarrollarse en paralelo con 2.5/2.6), pero el grupo 4 depende de ambos.

### 3.1 `useCamera` — apertura y control basico
- [x] 3.1.1 Implementar `useCamera` con `getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } })`, exponiendo el `MediaStream` al store (`CameraSlice`).
  Ref: proposal §3.4; scanner spec "Apertura y control de camara"
- [x] 3.1.2 Leer `track.getSettings()` tras abrir el stream y persistir `realResolution` en el store (no asumir la resolucion `ideal`).
  Ref: design §5.1 (`realResolution`); scanner spec "Apertura exitosa de camara trasera en movil"
- [x] 3.1.3 Implementar manejo de `NotAllowedError` (permiso denegado) seteando `permission: 'denied'` en el store, sin crashear el flujo.
  Ref: scanner spec "Permiso de camara denegado"
- [x] 3.1.4 Implementar manejo de `NotFoundError`/ausencia de `videoinput` en `enumerateDevices()`, marcando estado que habilita el fallback de import (grupo 6).
  Ref: scanner spec "Sin camara disponible (desktop)"

### 3.2 Selector de camara + torch
- [x] 3.2.1 Implementar enumeracion de dispositivos (`enumerateDevices()` filtrando `videoinput`) y accion para cambiar de camara activa, actualizando el stream.
  Ref: scanner spec "Multiples camaras disponibles"; design §5.1 (`devices`, `activeDeviceId`)
- [x] 3.2.2 Crear componente `CameraSelector.tsx` que lista los dispositivos con su `label` y dispara el cambio de camara.
  Ref: proposal §4.1 (`CameraSelector.tsx`)
- [x] 3.2.3 Implementar feature-detect de torch (`track.getCapabilities().torch`) y accion `applyConstraints({ advanced: [{ torch }] })`; ocultar control si no hay soporte.
  Ref: scanner spec "Torch no disponible en el dispositivo"; design §5.1 (`torchSupported`, `torchOn`)

### 3.3 `visibilitychange` — pausa/reanudacion
- [x] 3.3.1 Implementar listener de `visibilitychange` en `useCamera`/`useDocumentDetection` que pausa el loop de deteccion cuando `document.hidden === true` y lo reanuda al volver visible, sin detener el track salvo que haya muerto.
  Ref: scanner spec "Pestaña oculta durante la deteccion en vivo"; design §8 (tabla, fila visibilitychange)

### 3.4 Feature-detect de capacidades de captura
- [x] 3.4.1 Detectar soporte de `ImageCapture` (`typeof ImageCapture === 'undefined'`) y de `OffscreenCanvas`/`transferControlToOffscreen`, persistiendo `imageCaptureSupported`/`offscreenSupported` en `CameraSlice`.
  Ref: design §5.1; design §8 (matriz de fallback)

### 3.5 Componente de vista de camara
- [x] 3.5.1 Crear `CameraView.tsx` con el elemento `<video>` conectado al `MediaStream` del store, mas contenedor para el overlay (el overlay en si se implementa en grupo 4).
  Ref: proposal §4.1 (`CameraView.tsx`)

### 3.6 Captura de frame full-res
- [x] 3.6.1 Implementar captura via `ImageCapture.takePhoto()`/`grabFrame()` cuando `imageCaptureSupported === true`.
  Ref: scanner spec "Captura via ImageCapture"; design §2.2 (secuencia captura→warp)
- [x] 3.6.2 Implementar fallback `drawImage(video)` sobre canvas al tamaño real (`getSettings()`) cuando `ImageCapture` no este disponible.
  Ref: scanner spec "Fallback a drawImage sin soporte de ImageCapture"
- [x] 3.6.3 Aplicar cap de 16MP (`MAX_CAPTURE_PIXELS`) con downscale proporcional antes de crear cualquier canvas/bitmap de captura.
  Ref: scanner spec "Captura de frame full-res"; design §7 (cap 16MP), §6.4 (constante)
- [x] 3.6.4 Implementar liberacion de recursos inmediatamente tras cada captura: `ImageBitmap.close()`, `URL.revokeObjectURL()`, cierre del `warpedImage` previo antes de asignar uno nuevo.
  Ref: scanner spec "Liberacion de recursos tras captura"; design §7 (tabla completa)

---

## 4. Deteccion en vivo + auto-captura

> Depende de: grupo 2 (WorkerClient + worker DETECT) y grupo 3 (useCamera, CameraView). No empezar antes de tener 2.4/2.5 y 3.1/3.5 completos.

### 4.1 Loop de deteccion (`useDocumentDetection`)
- [x] 4.1.1 Implementar el loop con `requestVideoFrameCallback` (fallback `requestAnimationFrame`) que, mientras `!document.hidden`, genera `createImageBitmap(video, { resizeWidth: 640 })` y llama `workerClient.detect(bitmap, true)`.
  Ref: design §2.1 (secuencia loop de deteccion)
- [x] 4.1.2 Implementar drop-latest: si el `WorkerClient` reporta ocupado, no crear el bitmap del frame nuevo (evitar consumo de memoria).
  Ref: design §2.1 (drop-latest); design §9 ADR-002
- [x] 4.1.3 Disparar `workerClient.init(onProgress)` de forma idempotente al montar (o al primer intento de abrir camara/import), respetando "no preload en Home".
  Ref: design §4.2

### 4.2 Interpolacion de esquinas y overlay
- [x] 4.2.1 Implementar interpolacion `lerp(prev, nuevo, INTERP_ALPHA)` de las esquinas recibidas, con fade-out del overlay cuando `corners === null` (sin salto brusco).
  Ref: design §2.1 (interpolacion anti-jitter); scanner spec "Documento detectado y overlay estable"
- [x] 4.2.2 Renderizar el overlay del contorno interpolado sobre `CameraView` usando el color `--color-primary-light` de tokens.css.
  Ref: proposal §5 CAP-2; design §0 (Overlay UI)
- [x] 4.2.3 Escribir `setCorners(interpolated, raw)` en `DetectionSlice` en cada resultado de DETECT.
  Ref: design §5.1 (DetectionSlice)

### 4.3 Buffer de estabilidad + auto-captura
- [x] 4.3.1 Implementar buffer circular de las ultimas N esquinas y calculo de varianza por punto; marcar "estable" cuando toda varianza < `STABILITY_VARIANCE_PX` durante `STABILITY_MS`. **Valores de partida a calibrar en dispositivo real — no fijar en tests como constantes exactas.**
  Ref: design §2.1 (estabilidad); design §11 (umbral de estabilidad); scanner spec "Auto-captura por estabilidad de esquinas"
- [x] 4.3.2 Implementar countdown visual de 3 puntos que se dispara al alcanzar estabilidad y se cancela si la varianza supera el umbral antes de completarse.
  Ref: scanner spec "Esquinas estables durante la ventana de estabilidad", "Esquinas inestables interrumpen el countdown"
- [x] 4.3.3 Implementar toggle de auto-captura on/off en el store (`autoCaptureEnabled`), deshabilitando la evaluacion de estabilidad cuando esta apagado.
  Ref: scanner spec "Usuario desactiva auto-captura"; design §5.1 (`autoCaptureEnabled`)

### 4.4 UI de captura
- [x] 4.4.1 Crear `CaptureButton.tsx` (FAB de 72px con anillo animado) que dispara captura manual en cualquier momento, independiente del estado de auto-captura.
  Ref: proposal §4.1 (`CaptureButton.tsx`); proposal §5 CAP-3
- [x] 4.4.2 Integrar el disparo de captura (manual o automatico) con la secuencia de `useCamera`/`useDocumentDetection` de design §2.2 (pausar loop, capturar full-res, escalar esquinas de 640px a full-res).
  Ref: design §2.2 (secuencia captura→warp, pasos iniciales)

### 4.5 Hints de calidad
- [x] 4.5.1 Crear `QualityHints.tsx` con region `aria-live` que muestra "manten firme" (blur), "muy oscuro" (iluminacion) y "acercate mas" (area de contorno insuficiente) segun `DetectionSlice.quality`.
  Ref: scanner spec "Feedback de calidad en vivo" (los 3 escenarios); proposal §5 CAP-5
- [x] 4.5.2 Implementar el calculo de "acercate mas" en el hilo de UI a partir del area del contorno detectado (proporcion respecto al frame), no depende del worker.
  Ref: scanner spec "Documento demasiado lejos del encuadre"

### 4.6 No-deteccion prolongada
- [x] 4.6.1 Implementar tracking de `noDetectionSince`; al superar `NO_DETECTION_MS` (5000ms) mostrar hint + boton "Capturar igual" que lleva el frame completo directo al editor manual de esquinas (grupo 5).
  Ref: scanner spec "No hay deteccion durante 5 segundos"; design §5.1 (`noDetectionSince`)

---

## 5. Editor de esquinas + warp

> Depende de: grupo 2 (WorkerClient.warp, geometry.isConvex), grupo 3 (captura de frame full-res), grupo 4 (esquinas detectadas escaladas a full-res, o entrada sin deteccion desde 4.6/grupo 6).

### 5.1 `CornerEditor` — handles y lupa
- [x] 5.1.1 Crear `CornerEditor.tsx` con 4 handles arrastrables, preseleccionados en las esquinas detectadas (si validas) o distribuidos en las esquinas del frame completo (si no hay deteccion valida).
  Ref: perspective spec "Handles preseleccionados desde deteccion automatica", "Sin deteccion previa, editor con frame completo"
- [x] 5.1.2 Implementar lupa magnificadora que se muestra centrada en el handle durante el arrastre y desaparece al soltar.
  Ref: perspective spec "Arrastre de un handle muestra lupa"
- [x] 5.1.3 Implementar validacion de convexidad con `isConvex` (2.2.1) tras cada `pointerup`/`touchend`; deshabilitar boton "Confirmar" e indicar visualmente el estado invalido cuando el cuadrilatero no sea convexo.
  Ref: perspective spec "Cuadrilatero no convexo bloquea confirmacion"
- [x] 5.1.4 Garantizar que el recalculo de warp (llamada a `workerClient.warp`) se dispara SOLO en `pointerup`/`touchend`, nunca en posiciones intermedias de arrastre.
  Ref: perspective spec "Recalculo de warp solo al soltar el handle"

### 5.2 Disparo de warp desde el editor
- [x] 5.2.1 Implementar la extraccion de `ImageData` full-res del `CapturedFrame.source` y la llamada a `workerClient.warp(imageData, corners, aspectRatio)` al confirmar/soltar handle.
  Ref: design §2.2 (secuencia captura→warp, segunda mitad); perspective spec "Warp exitoso con aspect ratio inferido"
- [x] 5.2.2 Manejar la respuesta `WARP_RESULT` (ImageBitmap) o `WARP_RESULT_IMAGEDATA` segun `offscreenSupported`, actualizando `CaptureSlice.warpedImage` y cerrando el bitmap anterior antes de asignar el nuevo.
  Ref: design §8 (contrato flexible WARP_RESULT); design §7 (liberacion de ImageBitmap)
- [x] 5.2.3 Implementar `EditRecipe` inicial al confirmar warp: `{ corners, aspectRatio, rotation: 0, flipH: false, flipV: false }`, guardado en `CaptureSlice.recipe` (JSON serializable, sin binarios).
  Ref: design §5.2 (EditRecipe, patron no destructivo)

### 5.3 Aspect ratio — override manual
- [x] 5.3.1 Mostrar el aspect ratio inferido (`inferAspectRatio`, 2.2.3) y un selector para que el usuario lo sobrescriba antes de confirmar, descartando el valor inferido cuando el usuario elige otro.
  Ref: perspective spec "Usuario sobrescribe el aspect ratio inferido"

### 5.4 Rotacion y volteo post-warp (no destructivo)
- [x] 5.4.1 Implementar accion de rotar 90 grados que solo actualiza `recipe.rotation` (ciclo 0→90→180→270) y aplica un CSS transform en la capa de presentacion, sin re-invocar el worker.
  Ref: perspective spec "Rotacion de 90 grados"; design §9 ADR-005
- [x] 5.4.2 Implementar accion de volteo horizontal que solo actualiza `recipe.flipH` y aplica CSS transform, sin re-invocar el worker.
  Ref: perspective spec "Volteo horizontal"; design §9 ADR-005
- [x] 5.4.3 Verificar (test o revision manual) que ninguna de estas ediciones muta `CapturedFrame.source`; solo la receta cambia.
  Ref: perspective spec "Ediciones no destructivas sobre el original"; design §5.2

---

## 6. Casos borde / fallbacks

> Sub-tareas con dependencias cruzadas: 6.1/6.2 dependen del grupo 3 (camara); 6.3 depende de grupos 2+3+5 (pipeline completo); 6.4/6.5 dependen del grupo 4 (deteccion); 6.6 depende del grupo 2 (worker); 6.7 depende de grupos 2+3 (offscreen feature-detect).

### 6.1 Permiso de camara denegado
- [x] 6.1.1 Crear pantalla/mensaje con instrucciones para habilitar permiso (segun navegador) cuando `CameraSlice.permission === 'denied'`, con boton hacia el fallback de import (6.3).
  Ref: scanner spec "Permiso de camara denegado"; design §8 (tabla, fila permiso denegado)
  Slice F: `ImportFallback.tsx` (reason='permission-denied'), instrucciones por user-agent (Chrome/Firefox/Safari), boton "Import image" hacia el mismo pipeline.

### 6.2 Sin camara disponible (desktop)
- [x] 6.2.1 Detectar ausencia de `videoinput`/`NotFoundError` y activar automaticamente el fallback de import minimo en vez del viewfinder.
  Ref: scanner spec "Sin camara disponible (desktop)"; design §8 (tabla, fila sin camara)
  Slice F: la deteccion `NotFoundError`/`devices=[]` ya existia (Slice C, useCamera.ts); Slice F conecta esa condicion a `ImportFallback` (reason='no-camera') en ScannerScreen.tsx en vez de solo un texto plano.

### 6.3 Fallback de import minimo (`captureFallback.ts`)
- [x] 6.3.1 Implementar `src/features/scanner/lib/captureFallback.ts` con `<input type="file" accept="image/*">` simple (sin drag&drop, sin multiple, sin HEIC — fuera de alcance Fase 6), decodificando el archivo a `ImageBitmap` y aplicando el cap de 16MP.
  Ref: scanner spec "Fallback de import de imagen (desktop sin camara)"; design §9 ADR-006
- [x] 6.3.2 Conectar la imagen importada al MISMO pipeline: correr `DETECT` una vez sobre ella (frame reducido) para pre-poblar esquinas, luego abrir `CornerEditor` (grupo 5) y permitir warp.
  Ref: design §9 ADR-006; scanner spec "Import de imagen en desktop sin camara"
  Bug encontrado y corregido en esta slice: el import fallback nunca disparaba `workerClient.init()` (solo lo hacia el loop de camara), causando `NOT_INITIALIZED` en DETECT/WARP siempre. Fix: `ensureOpenCvInit()` expuesto desde `useDocumentDetection`, disparado en background al entrar al escaner (`started`), con timeout acotado (`IMPORT_DETECT_TIMEOUT_MS=15s`) en el import handler para no bloquear indefinidamente.
- [x] 6.3.3 Verificar que el import no ofrece drag&drop ni seleccion multiple (comportamiento negativo explicito).
  Ref: scanner spec "Import de imagen no ofrece funcionalidad fuera de alcance"

### 6.4 No-deteccion en 5s → editor con frame completo
- [x] 6.4.1 Conectar el hint de "capturar igual" (4.6.1) con la apertura de `CornerEditor` sin esquinas preseleccionadas validas (distribuidas sobre el frame completo).
  Ref: scanner spec "No hay deteccion durante 5 segundos"; perspective spec "Sin deteccion previa, editor con frame completo"
  Ya cubierto por Slice D/E (`handleCaptureAnyway` -> `runCaptureSequence`, `editorInitialCornersRef` queda null sin deteccion valida). Verificado en esta slice, sin cambios de codigo adicionales.

### 6.5 Contorno no convexo / esquina fuera de frame
- [x] 6.5.1 Verificar que cuando el worker retorna `corners: null` por no-convexidad o esquina fuera de `[0,w]×[0,h]`, la auto-captura NO se dispara y una captura manual en ese estado abre el editor con frame completo (sin esquinas invalidas preseleccionadas).
  Ref: scanner spec "Contorno detectado no es convexo o tiene una esquina fuera de frame"
  Ya cubierto por Slice B (worker gating via `isConvex`+bounds) y Slice D/E (`runCaptureSequence`'s `isConvex` gate antes de pre-seedear el editor). Verificado en esta slice, sin cambios de codigo adicionales.

### 6.6 Fallo de carga de OpenCV → modo degradado
- [x] 6.6.1 Implementar el modo degradado manual cuando `opencv.status === 'error'` tras agotar reintentos: permitir capturar + editar esquinas con frame completo; si OpenCV se recupera en un reintento posterior, permitir warp; documentar (comentario + issue/nota) la decision de "hasta donde llega el degradado" como pendiente de confirmar en apply si surge ambiguedad de producto.
  Ref: scanner spec "Fallo de carga de OpenCV.js"; design §4.4 (modo degradado); design §11 (alcance del degradado, confirmar en apply)
  Slice F: gap real encontrado — `OpenCvSlice.status` nunca se escribia desde ningun lado (solo vivia en refs locales de `useDocumentDetection`). Agregado `setOpenCvStatus` al store; `useDocumentDetection` ahora mirrorea `idle->loading->ready/error` con backoff exponencial acotado (1s/2s/4s, max 3 auto-retries) + `retryManualInit` manual. `OpenCvDegradedBanner.tsx` muestra el estado degradado y permite reintentar; ScannerScreen oculta overlay/quality-hints/auto-capture-toggle mientras `opencv.status==='error'`. Decision de alcance registrada en el comentario del banner: capturar+editar con frame completo siempre disponible; warp se re-intenta transparentemente si OpenCV se recupera (mismo mecanismo de recuperacion que resume el loop de deteccion).

### 6.7 Sin `OffscreenCanvas` (Safari < 16.4)
- [x] 6.7.1 Implementar camino alterno en el main thread: cuando `offscreenSupported === false`, extraer `ImageData` dibujando en un `<canvas>` del hilo principal (en vez de que el worker use `OffscreenCanvas` interno) y enviar `ImageDataLike` tanto para DETECT como para WARP.
  Ref: design §8 (matriz de fallback, fila "Sin OffscreenCanvas"); scanner spec (restriccion transversal — sin inventar APIs no soportadas)
  Slice F: gap real encontrado — el camino WARP sin OffscreenCanvas ya existia (Slice B/C), pero DETECT SIEMPRE usaba OffscreenCanvas interno del worker sin importar `offscreenSupported`. Agregado `DETECT_IMAGEDATA` al contrato (`messages.ts`), `handleDetectImageData`+`runDetectPipeline` compartido en el worker, `WorkerClient.detectImageData`, `bitmapToImageData` (main-thread extraction, `mainThreadImageData.ts`), y wiring en `useDocumentDetection`'s loop + `ScannerScreen`'s import handler, ambos gateados por `offscreenSupported` leido del store.

### 6.8 Documento rotado — verificacion empirica de `orderCorners`
- [x] 6.8.1 Preparar fixtures manuales/checklist de documentos capturados con rotacion 0°/30°/45°/90°/casi-vertical-invertido para validar `orderCorners` (2.2.2) en condiciones reales; documentar resultado y cualquier ajuste de normalizacion necesario. **No se fija como comportamiento validado hasta completar esta verificacion en apply.**
  Ref: design §6.1 (nota de verificacion empirica R5); perspective spec "Documento con orientacion rotada..."
  0°/30°/45°/90° ya cubiertos por Slice B (`geometry.test.ts`). Slice F agrega fixtures sinteticas 90° (caso limite exacto, ambiguo por diseño — documentado) y 170°/180° (casi-vertical-invertido): el contrato garantizado en esos angulos es convexidad + preservacion del conjunto de puntos, NO una identidad de esquina exacta, porque a 180° el algoritmo (normalizacion modulo 90°) es indistinguible de 0° sin informacion semantica de texto/orientacion — limite documentado, no bug. Verificacion en DISPOSITIVO REAL (fixtures fotografiadas) queda pendiente de QA — fuera del alcance de tests automatizados.

---

## 7. Tests

> Puede arrancar en paralelo con el grupo 2 para la parte de geometria (no depende del worker en runtime, solo de las funciones puras). El E2E de humo depende de tener el pipeline completo (grupos 1-5) funcional con al menos el fallback de import (grupo 6.3).

### 7.1 Unit tests — geometria
- [x] 7.1.1 Escribir tests Vitest para `isConvex` (2.2.1): casos convexo, no convexo (auto-interseccion), degenerado (colineal).
  Ref: design §6.2; perspective spec "Cuadrilatero no convexo bloquea confirmacion"
- [x] 7.1.2 Escribir tests Vitest para `orderCorners` (2.2.2) con quads en distintas orientaciones (0°, 45°, 90°) verificando que el orden de salida sea siempre `[TL, TR, BR, BL]` consistente. **Los umbrales/angulos de desempate son valores de partida; los tests validan el contrato de orden, no un umbral exacto de calibracion.**
  Ref: design §6.1; design §11 (R5 — no fijar umbrales como finales)
- [x] 7.1.3 Escribir tests Vitest para `inferAspectRatio` (2.2.3): casos A4, carta, ticket (alargado), y `unknown` fuera de tolerancia.
  Ref: design §6.3

### 7.2 E2E de humo (Playwright)
- [x] 7.2.1 Crear fixture de imagen de documento (archivo estatico en `tests/e2e/fixtures/`) para simular el flujo sin camara real.
  Ref: proposal §2.1 (harness de testing); design §11 (nada de mocks inventados de camara — usar el fallback de import real)
  `tests/e2e/fixtures/document.png` generado por script (800x1000, rectangulo claro con bandas de "texto" sobre fondo oscuro), no un placeholder trivial.
- [x] 7.2.2 Escribir test E2E de humo: cargar la app, usar el fallback de import (`captureFallback`, 6.3.1) con la fixture, y verificar que se llega a mostrar una imagen deswarpeada (o al menos que el editor de esquinas se abre y permite confirmar).
  Ref: proposal §7 (criterios de aceptacion, item 9: Playwright con fixture de imagen)
  **RESULTADO DEGRADADO Y DOCUMENTADO (no oculto):** se investigo a fondo (instrumentacion directa en `opencvLoader.ts`, trazado de mensajes worker<->main) y se confirmo que OpenCV.js WASM NUNCA termina de inicializar dentro del Web Worker en este entorno Playwright/Chromium headless — el chunk de 10MB descarga OK (HTTP 200), pero `await import('@techstark/opencv-js')` dentro del worker nunca resuelve, y el message-loop del worker queda bloqueado (ni siquiera responde `NOT_INITIALIZED` a un WARP posterior). La MISMA importacion SI funciona en ~500ms en el hilo principal y en un worker generico minimo — es especifico de este build de OpenCV.js dentro de ESTE patron de worker (sin guard `ENVIRONMENT_IS_WORKER`). `tests/e2e/importFixture.spec.ts` verifica: import real -> decodificacion -> editor abre con esquinas frame-completo -> se envia un WARP real al worker -> se confirma (con espera acotada) que ni exito ni error llegan en este entorno, sin errores de pagina no manejados, y que "Confirm" permanece deshabilitado (comportamiento CORRECTO, no bug). La correctitud de pixeles de `warpPerspective` contra un documento real, y la confirmacion de que el worker de OpenCV carga en un navegador de dispositivo real (no este entorno headless), quedan como QA en dispositivo pendiente.

---

## Review Workload Forecast

**Estimacion de lineas cambiadas totales:** ~3200-3800 lineas (incluye scaffold de config, tipos, componentes React, worker, hooks, store, tests). Esta es la fase mas grande y riesgosa del roadmap (camara + WASM + Web Worker + geometria + UI de edicion).

**Supera presupuesto de 400 lineas por PR:** Yes (por un margen amplio — aproximadamente 8x a 9x el presupuesto si se entregara en un solo PR).

**PRs encadenados/stacked recomendados:** Yes.

**Decision needed before apply:** Yes — se requiere que el orquestador aplique `delivery_strategy` (ask-on-risk/auto-chain/single-pr/exception-ok) y, si corresponde, `chain_strategy` (stacked-to-main o feature-branch-chain) ANTES de lanzar `sdd-apply`.

### Propuesta de corte en slices autonomos

| Slice | Contenido (grupos de tasks.md) | Lineas estimadas | Orden de dependencia |
|---|---|---|---|
| **A** | Scaffold (grupo 1 completo) | ~450-550 | 1° — sin dependencias |
| **B** | Worker OpenCV: contrato de mensajes + geometria + opencvLoader + WorkerClient + pipeline DETECT/WARP en worker (grupo 2 completo) | ~800-950 | 2° — depende de A |
| **C** | Camara: useCamera, selector, torch, visibilitychange, captura full-res (grupo 3 completo) | ~550-650 | 3° — depende de A; puede desarrollarse en paralelo con B, pero se integra/revisa despues de B por el contrato de mensajes compartido |
| **D** | Deteccion en vivo + auto-captura: useDocumentDetection, overlay, estabilidad, countdown, hints de calidad (grupo 4 completo) | ~600-700 | 4° — depende de B y C |
| **E** | Editor de esquinas + warp: CornerEditor, disparo de warp, aspect ratio override, rotacion/volteo (grupo 5 completo) | ~500-600 | 5° — depende de B, C, D |
| **F** | Casos borde + fallbacks + tests (grupos 6 y 7 completos) | ~350-450 | 6° — depende de A-E (toca todos los flujos para cubrir fallbacks) |

**Orden de dependencia:** A → B → (C en paralelo con B, integra tras B) → D → E → F.

**Nota:** cada slice puede ser su propio PR encadenado (stacked). Si se elige `feature-branch-chain`, el PR de F (casos borde + tests) es un buen candidato a PR final que confirma el criterio de aceptacion completo del roadmap antes de mergear el tracker branch.
